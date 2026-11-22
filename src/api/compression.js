/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************/
'use strict'

const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const { getLogger } = require('../observability')
const {
    getGzipJsonMetadata,
    sha256File,
    validateBootstrapArchiveOrThrow,
    assertExtractedStoreOrThrow
} = require('./errors.js')
const {
    STAGING_DIR_NAME,
    prepareStagingDir,
    discardStagingDir,
    assertStagedLayoutOrThrow,
    promoteStagedStore
} = require('../bootstrap/staged_restore.js')
const { evaluateRestoreAgainstNodeTip } = require('../bootstrap/node_tip_guard.js')

const tasks = {}
const logger = getLogger()

function setTaskProgress(taskId, progress) {
    const task = tasks[taskId]
    if (!task || task.progress === -1 || task.error) return
    task.progress = progress
}

async function compressDirPigz(taskId, source, destination) {
    tasks[taskId] = {progress: 0, filename: destination}

    // Calculate source size with du
    const duProcess = spawn('du', ['-sb', source])
    let totalBytesString = ''

    duProcess.stdout.on('data', (data) => {
        totalBytesString += data.toString()
    })

    await new Promise((resolve, reject) => {
        duProcess.on('close', (code) => {
            if (code !== 0) {
                return reject(new Error(`Error obtaining source size with "du" command with code ${code}`))
            }
            resolve()
        })
        duProcess.on('error', (err) => reject(new Error(`Error with du command: ${err.message}`)))
    })

    const totalBytes = parseInt(totalBytesString.split('\t')[0], 10)

    if (isNaN(totalBytes) || totalBytes <= 0) {
        // KEEP the task record: this rejection is routed through getbootstrap's
        // .catch into handleBootstrapFailure, whose recordFailure is guarded on
        // tasks[taskId] and no-ops once the record is gone. Deleting here made
        // getbootstrapstatus answer "taskid doesn't exist" instead of the real
        // failure, defeating that invariant. The du non-zero-exit
        // reject above already leaves the record intact; this branch now matches.
        logger.error(`Error: Invalid size for source '${source}'.`)
        throw new Error(`Invalid size for source: ${totalBytes}`)
    }

    return compressToDestination(taskId, source, destination, totalBytes)
}

function invalidateSnapshotSidecar(taskId, destination) {
    const sidecar = destination + '.sha256'
    try {
        fs.renameSync(sidecar, `${sidecar}.invalid-${taskId}`)
    } catch (err) {
        if (!err || err.code !== 'ENOENT') throw err
    }
}

function waitForChild(child, label) {
    return new Promise((resolve, reject) => {
        child.once('close', (code) => code === 0
            ? resolve()
            : reject(new Error(`${label} throwed an error with código ${code}`)))
        child.once('error', (err) => reject(new Error(
            `${label}${label === 'pigz' ? ' fail' : ' failed'} to init: ${err.message}`)))
    })
}

function waitForOutput(outputStream) {
    if (outputStream.writableFinished) return Promise.resolve()
    return new Promise((resolve, reject) => {
        outputStream.once('finish', resolve)
        outputStream.once('error', (err) => reject(new Error(`snapshot write failed: ${err.message}`)))
    })
}

async function compressToDestination(taskId, source, destination, totalBytes) {
    // A replacement truncates the archive as soon as its stream opens. Move any
    // prior sidecar out of the canonical location first, so a failed replacement
    // cannot be restored under a checksum that describes the old bytes.
    invalidateSnapshotSidecar(taskId, destination)

    // -c: create, -f -: output to stdout. A staging directory left by an interrupted
    // restore sits in the same directory but is not part of the store, so it is not packed.
    const tar = spawn('tar', ['-cf', '-', '--exclude=./' + STAGING_DIR_NAME, '-C', source, '.'])
    const pv = spawn('pv', [
        '-s', totalBytes.toString(), // -s: expected total size,
        '-n', '-f' //-n: progress in number -f: force output
    ])
    const pigz = spawn('pigz', ['-C', JSON.stringify({"original_size":totalBytes.toString()})]) //-C add a comment to the final file, this will be the original size to calculate progress when decompressing

    tar.stdout.pipe(pv.stdin)
    pv.stdout.pipe(pigz.stdin)
    const outputStream = fs.createWriteStream(destination)
    pigz.stdout.pipe(outputStream)

    pv.stderr.on('data', (data) => {
        // handling pv progress
        const percentageString = data.toString().trim(); // pv -n prints the progress and a line break
        const currentPercentage = parseInt(percentageString, 10);

        if (!isNaN(currentPercentage)) { // Check if the percentage is a valid number
            setTaskProgress(taskId, currentPercentage)
        }
    })

    await Promise.all([
        waitForChild(tar, 'tar'),
        waitForChild(pv, 'pv'),
        waitForChild(pigz, 'pigz'),
        waitForOutput(outputStream),
    ])
    return finishSnapshot(outputStream, destination)
}

// Write the .sha256 sidecar the single-layer restore path verifies
// against, so restoring our OWN snapshot still gets a real
// integrity check rather than needing BOOTSTRAP_RESTORE_ALLOW_UNVERIFIED=1.
// sha256sum format (`<hex>  <name>`) so both parseSha256Sidecar and a
// plain `sha256sum -c` accept it. This snapshot is UNSIGNED (no signing
// key lives in the tracker container), so restoring it does need the
// separate BOOTSTRAP_RESTORE_ALLOW_UNSIGNED=1 provenance opt-out:
// a locally-produced archive has no publisher to authenticate.
// Hash the flushed file, not the bytes pigz emitted: the child
// exiting leaves the stream mid-write, and a small archive may
// already be finished, so a bare 'finish' wait would never fire.
function finishSnapshot(outputStream, destination) {
    const flushed = outputStream.writableFinished
        ? Promise.resolve()
        : new Promise((onFlush, onFail) => {
            outputStream.once('finish', onFlush)
            outputStream.once('error', onFail)
        })
    return flushed
        .then(() => sha256File(destination))
        .then((digest) => fs.promises.writeFile(
            destination + '.sha256',
            `${digest}  ${path.basename(destination)}\n`))
        .then(() => destination)
}

async function guardRestoreNodeTip(archiveHeight, readNodeTip, phase) {
    let chainInfo = null
    try {
        if (typeof readNodeTip === 'function') chainInfo = await readNodeTip()
    } catch (err) {
        logger.warn(`Restore node-tip check at ${phase} could not read the coin node: ${err && err.message}`)
    }
    const assessment = evaluateRestoreAgainstNodeTip({ archiveHeight, chainInfo })
    if (assessment.verdict === 'behind-refuse') {
        throw new Error(`Refusing to restore: ${assessment.detail}. Nothing was wiped. `
            + `Wait until the node reaches height ${archiveHeight}, then run restorebootstrap again.`)
    }
    if (assessment.verdict === 'behind-wait') {
        logger.warn(`Restore node-tip check at ${phase}: ${assessment.detail}; the tracker will wait for the node.`)
    } else if (assessment.verdict === 'unknown') {
        logger.warn(`Restore node-tip check at ${phase} is unavailable: ${assessment.detail}; continuing with existing restore gates.`)
    }
    return assessment
}

async function decompressPigz(taskId, source, destination, { readNodeTip } = {}) {
    // Validate BEFORE the destructive wipe: an unsigned, wrong-layout, checksum-failing,
    // or not-a-LevelDB-store archive must abort with the live DB intact, never delete
    // /data then restore a corrupt, empty, or attacker-chosen store. A wrapper archive
    // is unwrapped+verified here and its inner data.tar.gz becomes the effective source;
    // tmpDir (outside /data) is cleaned up after the pipeline completes.
    // Pre-wipe validation runs with the live DB still intact, so any error escaping
    // it (missing/invalid sidecar, checksum mismatch, wrapper unwrap failure) is a
    // recoverable abort, NOT the post-wipe fail-loud regime. Tag it so the caller's
    // failure handler resumes indexing instead of exiting the process (the /data
    // store was never touched). Inside decompressPigzInner only the wipe and the move of the staged store are post-wipe.
    let effectiveSource, tmpDir, meta, provenanceVerified
    try {
        ({ effectiveSource, tmpDir, meta, provenanceVerified } = await validateBootstrapArchiveOrThrow(source))
    } catch (err) {
        if (err && typeof err === 'object') err.preWipe = true
        throw err
    }
    const cleanupTmp = () => { if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {} } }
    if (provenanceVerified && meta && meta.height !== null) {
        try { await guardRestoreNodeTip(meta.height, readNodeTip, 'authenticated metadata') }
        catch (err) {
            cleanupTmp()
            if (err && typeof err === 'object') err.preWipe = true
            throw err
        }
    }
    try {
        return await decompressPigzInner(taskId, effectiveSource, destination, readNodeTip)
    } finally {
        cleanupTmp()
    }
}

// Extracts into a staging directory inside `destination`, checks the store layout
// there, and only then replaces the live store. Every failure up to and including
// the layout check is tagged preWipe: the live store has not been touched yet.
async function decompressPigzInner(taskId, source, destination, readNodeTip) {
    // Read the comment in the GZIP file
    const comment = await getGzipJsonMetadata(source)
    let totalUncompressedBytes = null

    if (comment) {
        try {
            totalUncompressedBytes = comment["original_size"]
        } catch(err) {
            logger.warn("WARNING: Couldn't find a valid metadata in the compressed file. There will be no progress to show.")
        }
    } else {
        logger.warn("WARNING: Couldn't find any metadata in the compressed file. There will be no progress to show.")
    }

    logger.info(`Decompressing from "${source}" into a staging directory under "${destination}"...`)

    try {
        const staging = prepareStagingDir(destination)
        await extractArchive(taskId, source, staging, totalUncompressedBytes)
        const stagedHeight = await assertStagedLayoutOrThrow(staging)
        await guardRestoreNodeTip(stagedHeight, readNodeTip, 'staged store')
    } catch (err) {
        try { discardStagingDir(destination) } catch (_) {}
        if (err && typeof err === 'object') err.preWipe = true
        throw err
    }

    logger.info("Deleting data directory")
    deleteFilesInDirectorySync(destination, STAGING_DIR_NAME)
    promoteStagedStore(destination)
    logger.info(`Process completed. Dir "${destination}".`)
    return destination
}

function trackExtractionProgress(pv, taskId) {
    pv.stderr.on('data', (data) => {
        // handling pv progress
        const percentageString = data.toString().trim(); // pv -n prints the progress and a line break
        const currentPercentage = parseInt(percentageString, 10);

        if (!isNaN(currentPercentage)) {
            setTaskProgress(taskId, currentPercentage)
        }
    })
}

function extractArchive(taskId, source, destination, totalUncompressedBytes) {
    // Execute pigz -d -> pv -> tar -x
    const pigz = spawn('pigz', ['-d', '-c', source])

    const pvArgs = ['-n', '-f']
    if (totalUncompressedBytes !== null) {
        pvArgs.unshift('-s', totalUncompressedBytes.toString()) // Add -s only if the size is valid
    }
    const pv = spawn('pv', pvArgs)
    const tar = spawn('tar', ['-x', '-f', '-', '-C', destination])

    // Connect the processes
    pigz.stdout.pipe(pv.stdin)
    pv.stdout.pipe(tar.stdin)

    trackExtractionProgress(pv, taskId)

    // Handling errors
    pigz.stderr.on('data', (data) => { logger.error(`Error from pigz: ${data}`) })
    tar.stderr.on('data', (data) => { logger.error(`Error from tar: ${data}`) })

    return new Promise((resolve, reject) => {
        let pigzError = null
        let pvError = null
        let tarError = null

        pigz.on('close', (code) => {
            if (code !== 0) pigzError = new Error(`pigz exited with code ${code}`)
        })
        pv.on('close', (code) => {
            if (code !== 0) pvError = new Error(`pv exited with code ${code}`)
        })
        tar.on('close', (code) => {
            if (code !== 0) tarError = new Error(`tar exited with code ${code}`)

            if (pigzError || pvError || tarError) {
                reject(pigzError || pvError || tarError);
            } else {
                // tar exiting 0 says the members were written SOMEWHERE under
                // `destination`, never that they landed as a usable store at its root:
                // extraction preserves the archive's own directories, so a store packed
                // one level down lands at destination/<dir>/CURRENT and the tracker
                // would reopen onto an empty DB. Assert the ground truth on disk; the
                // destination here is the staging directory, so a failure aborts the
                // restore with the live store still in place.
                try { assertExtractedStoreOrThrow(destination) }
                catch (err) { return reject(err) }
                logger.info(`Extraction completed. Dir "${destination}".`);
                resolve(destination)
            }
        })

        pigz.on('error', (err) => reject(new Error(`pigz fail to init: ${err.message}`)));
        pv.on('error', (err) => reject(new Error(`pv failed to init: ${err.message}`)));
        tar.on('error', (err) => reject(new Error(`tar failed to init: ${err.message}`)));
    })
}

// Empties `directoryPath`, leaving the entry named `keep` (a staged store) alone.
function deleteFilesInDirectorySync(directoryPath, keep = null) {
    try {
        const files = fs.readdirSync(directoryPath, { withFileTypes: true })

        for (const file of files) {
            if (file.name === keep) continue
            const filePath = path.join(directoryPath, file.name)
            if (file.isDirectory()) {
                fs.rmSync(filePath, { recursive: true })
            } else {
                fs.rmSync(filePath)
            }
        }
    } catch (err) {
        logger.error(err && err.stack ? err.stack : String(err))
        // Carry the fs reason (EACCES, EBUSY...) in the message and as cause: Error's
        // second argument is an options object, so passing err bare dropped it.
        const reason = err && err.message ? err.message : String(err)
        throw new Error(`Error trying to delete the content of ${directoryPath}: ${reason}`, { cause: err })
    }
}

module.exports = { compressDirPigz, decompressPigz, deleteFilesInDirectorySync, tasks }
