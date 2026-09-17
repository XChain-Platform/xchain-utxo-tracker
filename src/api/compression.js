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

const tasks = {}
const logger = getLogger()

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

function compressToDestination(taskId, source, destination, totalBytes) {
    const tar = spawn('tar', ['-cf', '-', '-C', source, '.']) // -c: create, -f -: output to stdout
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
            tasks[taskId]["progress"] = currentPercentage
        }
    })

    // Error handling and finishing processes
    return new Promise((resolve, reject) => {
        let tarError = null
        let pvError = null
        let pigzError = null

        tar.on('close', (code) => {
            if (code !== 0) tarError = new Error(`tar throwed an error with código ${code}`)
        })
        pv.on('close', (code) => {
            if (code !== 0) pvError = new Error(`pv throwed an error with código ${code}`)
        })
        pigz.on('close', (code) => {
            if (code !== 0) pigzError = new Error(`pigz throwed an error with código ${code}`)

            // If there is an error reject the whole process
            if (tarError || pvError || pigzError) {
                reject(tarError || pvError || pigzError)
            } else {
                finishSnapshot(outputStream, destination).then(resolve).catch(reject)
            }
        })

        // Handling init errors
        tar.on('error', (err) => reject(new Error(`tar failed to init: ${err.message}`)))
        pv.on('error', (err) => reject(new Error(`pv failed to init: ${err.message}`)))
        pigz.on('error', (err) => reject(new Error(`pigz fail to init: ${err.message}`)))
        // Route a write failure (a full disk, a read-only mount) into the same
        // rejection: an unhandled 'error' on this stream takes the process down.
        outputStream.on('error', (err) => reject(new Error(`snapshot write failed: ${err.message}`)))
    })
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

async function decompressPigz(taskId, source, destination) {
    // Validate BEFORE the destructive wipe: an unsigned, wrong-layout, checksum-failing,
    // or not-a-LevelDB-store archive must abort with the live DB intact, never delete
    // /data then restore a corrupt, empty, or attacker-chosen store. A wrapper archive
    // is unwrapped+verified here and its inner data.tar.gz becomes the effective source;
    // tmpDir (outside /data) is cleaned up after the pipeline completes.
    // Pre-wipe validation runs with the live DB still intact, so any error escaping
    // it (missing/invalid sidecar, checksum mismatch, wrapper unwrap failure) is a
    // recoverable abort, NOT the post-wipe fail-loud regime. Tag it so the caller's
    // failure handler resumes indexing instead of exiting the process (the /data
    // store was never touched). Only decompressPigzInner, below, is post-wipe.
    let effectiveSource, tmpDir
    try {
        ({ effectiveSource, tmpDir } = await validateBootstrapArchiveOrThrow(source))
    } catch (err) {
        if (err && typeof err === 'object') err.preWipe = true
        throw err
    }
    const cleanupTmp = () => { if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {} } }
    try {
        return await decompressPigzInner(taskId, effectiveSource, destination)
    } finally {
        cleanupTmp()
    }
}

async function decompressPigzInner(taskId, source, destination) {
    logger.info("Deleting data directory")
    deleteFilesInDirectorySync(destination)
    //fs.mkdirSync(destination, { recursive: true })
    logger.info("Decompressing the data...")

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

    logger.info(`Decompressing from "${source}" to "${destination}"...`)

    return extractArchive(taskId, source, destination, totalUncompressedBytes)
}

function trackExtractionProgress(pv, taskId) {
    pv.stderr.on('data', (data) => {
        // handling pv progress
        const percentageString = data.toString().trim(); // pv -n prints the progress and a line break
        const currentPercentage = parseInt(percentageString, 10);

        if (!isNaN(currentPercentage)) {
            tasks[taskId]["progress"] = currentPercentage
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
                // reopens onto an empty DB while this path reports success. Assert the
                // ground truth on disk instead, after the wipe has already happened, so
                // the restore fails loud through handleRestoreFailure rather than
                // clearing the halt and relaunching over a database that is not there.
                try { assertExtractedStoreOrThrow(destination) }
                catch (err) { return reject(err) }
                logger.info(`Process completed. Dir "${destination}".`);
                resolve(destination)
            }
        })

        pigz.on('error', (err) => reject(new Error(`pigz fail to init: ${err.message}`)));
        pv.on('error', (err) => reject(new Error(`pv failed to init: ${err.message}`)));
        tar.on('error', (err) => reject(new Error(`tar failed to init: ${err.message}`)));
    })
}

function deleteFilesInDirectorySync(directoryPath) {
    try {
        const files = fs.readdirSync(directoryPath, { withFileTypes: true })

        for (const file of files) {
            const filePath = path.join(directoryPath, file.name)
            if (file.isDirectory()) {
                fs.rmSync(filePath, { recursive: true })
            } else {
                fs.rmSync(filePath)
            }
        }
    } catch (err) {
        logger.info(err && err.stack ? err.stack : String(err))
        throw new Error(`Error trying to delete the content of ${directoryPath}:`, err)
    }
}

module.exports = { compressDirPigz, decompressPigz, tasks }
