'use strict'

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************/

const fs             = require('fs')
const path           = require('path')
const { externalSort }  = require('../merger/external_sort.js')
const { leftAntiJoin }  = require('../merger/streaming_join.js')
const { deriveKeys }    = require('../merger/derive_keys.js')
const { loadKeys }      = require('../merger/loader.js')
const { HEADER_SIZE, OUTPUTS_RECORD_SIZE, SPENDS_RECORD_SIZE } = require('../writers.js')
const { networkToCodes, validateConcatArtifact, parseDatHeader,
        writeSortedManifest, checkSortedManifest } = require('../merger/resume_manifest.js')
const { OUTPUTS_KEY_SIZE, SPENDS_KEY_SIZE, BULK_SYNC_DIR } = require('./constants.js')
const { concatFilesWithHeader, readOutputsRecordSize, findFiles } = require('./file_ops.js')

// The orchestrator entry owns the process output (log) and the child spawn
// that inherits its environment (runChild), and passes both to each phase.

// phases

async function phaseDump(args, dirs, { log, runChild }) {
    log('DUMP', `dumping blocks to ${dirs.dumps}`)
    const dumpArgs = [
        '--network', args.network,
        '--from', String(args.from),
        '--chunk-size', String(args.chunkSize),
        '--out', dirs.dumps,
    ]
    if (args.to !== null) {
        dumpArgs.push('--to', String(args.to))
        // dump.js rejects an explicit --to inside the live undo window unless this
        // rides along, so the override has to reach the child.
        if (args.allowUndoWindow) dumpArgs.push('--allow-undo-window')
    } else {
        dumpArgs.push('--tip-safety', String(args.tipSafety))
    }
    await runChild(path.join(BULK_SYNC_DIR, 'dump.js'), dumpArgs)
    const xdmpFiles = findFiles(dirs.dumps, 'blocks-', '.xdmp')
    log('DUMP', `done: ${xdmpFiles.length} .xdmp files`)
    return xdmpFiles
}

async function phaseParse(args, dirs, xdmpFiles, { log, runChild }) {
    const maxWorkers = args.workers || xdmpFiles.length
    log('PARSE', `parsing ${xdmpFiles.length} dumps with up to ${maxWorkers} parallel workers`)

    // Process in batches of maxWorkers
    for (let i = 0; i < xdmpFiles.length; i += maxWorkers) {
        const batch = xdmpFiles.slice(i, i + maxWorkers)
        const promises = batch.map(xdmpPath => {
            const parseArgs = ['--in', xdmpPath, '--out', dirs.parsed]
            return runChild(path.join(BULK_SYNC_DIR, 'parse_worker.js'), parseArgs)
        })
        await Promise.all(promises)
        log('PARSE', `batch done: ${Math.min(i + maxWorkers, xdmpFiles.length)}/${xdmpFiles.length}`)
    }

    log('PARSE', 'all workers done')

    // Dumps are consumed only by parse. Keeping them through MERGE risks
    // ENOSPC because the sort phase needs hundreds of GB of scratch space.
    log('PARSE', `removing ${dirs.dumps} to free disk for merge`)
    fs.rmSync(dirs.dumps, { recursive: true, force: true })
}

async function phaseMerge(args, dirs, cleanup, { log }) {
    const allOutputsPath = path.join(dirs.merge, 'all-outputs.dat')
    const allSpendsPath  = path.join(dirs.merge, 'all-spends.dat')
    const allMetaPath    = path.join(dirs.merge, 'all-meta.dat')

    concatOrReuse(args, dirs, allOutputsPath, allSpendsPath, allMetaPath, log)

    const ramBudgetBytes = args.ramBudget * 1024 * 1024

    // The dump header's record_size field (offset 28, u32 LE) is the explicit
    // format discriminator: new dumps report 121 (trailing coinbase flag),
    // legacy dumps report 120. Threading it through the sort, anti-join and
    // deriveKeys lets both widths merge; a legacy dump carries no flag and its
    // outputs are treated as non-coinbase. Fall back to the compiled constant if
    // the field is absent (0), so a pre-record_size dump still parses.
    const outputsRecordSize = readOutputsRecordSize(allOutputsPath)
    log('MERGE', `outputs record size = ${outputsRecordSize}B (${outputsRecordSize === OUTPUTS_RECORD_SIZE ? 'coinbase-flagged' : 'legacy'})`)

    const sortedOutputsPath = await sortOutputs(dirs, allOutputsPath, outputsRecordSize, ramBudgetBytes, log)
    const sortedSpendsPath = await sortSpends(dirs, allSpendsPath, ramBudgetBytes, log)

    // all-spends.dat is no longer read after spends-sorted.dat is built.
    cleanup.enqueue(allSpendsPath, 'merge/all-spends.dat')
    cleanup.maybeFree('after sort-spends')

    const liveUtxosPath = await antiJoinLiveUtxos(args, dirs, sortedOutputsPath, sortedSpendsPath, outputsRecordSize, log)

    // outputs-sorted.dat is only read by the anti-join above.
    cleanup.enqueue(sortedOutputsPath, 'merge/outputs-sorted.dat')
    cleanup.maybeFree('after anti-join')

    return deriveLevelDbKeys(args, dirs, cleanup, { allMetaPath, allOutputsPath, liveUtxosPath, sortedSpendsPath },
        outputsRecordSize, ramBudgetBytes, log)
}

// Whether the three concatenated merge inputs on disk belong to this run.
function concatReusableForRun(args, allOutputsPath, allSpendsPath, allMetaPath, log) {
    // Skip concat if prior crash (or prior run) already produced the three
    // concatenated files AND their self-describing headers prove they belong
    // to THIS run. Bare existence left a stale-artifact window: a merge dir
    // reused across runs could hold same-named files from a different
    // range/network and the pipeline would silently seed the DB from them.
    // On mismatch we log why and rebuild from the parsed inputs (concat fails
    // loud if those are gone, pointing the operator at a re-parse).
    let concatReusable = fs.existsSync(allOutputsPath) && fs.existsSync(allSpendsPath) && fs.existsSync(allMetaPath)
    if (concatReusable) {
        const expectedIdentity = { ...networkToCodes(args.network), from: args.from, to: args.to }
        const checks = [allOutputsPath, allSpendsPath, allMetaPath].map(p => validateConcatArtifact(p, expectedIdentity))
        const bad = checks.find(c => !c.ok)
        if (bad) {
            log('MERGE', `stale concat artifact, rebuilding: ${bad.reason}`)
            concatReusable = false
        } else {
            // The three artifacts must also agree with EACH OTHER on the range
            // (a partial earlier crash can leave one file from an older run).
            const [outH, spdH, metaH] = checks.map(c => c.header)
            for (const [name, h] of [['spends', spdH], ['meta', metaH]]) {
                if (h.firstHeight !== outH.firstHeight || h.lastHeight !== outH.lastHeight) {
                    log('MERGE', `stale concat artifact, rebuilding: all-${name}.dat range ${h.firstHeight}..${h.lastHeight} != all-outputs.dat ${outH.firstHeight}..${outH.lastHeight}`)
                    concatReusable = false
                    break
                }
            }
        }
    }
    return concatReusable
}

// Build the three merge inputs from the per-worker parsed files, unless the
// ones already on disk belong to this run.
function concatOrReuse(args, dirs, allOutputsPath, allSpendsPath, allMetaPath, log) {
    const concatReusable = concatReusableForRun(args, allOutputsPath, allSpendsPath, allMetaPath, log)
    if (concatReusable) {
        const outMB = (fs.statSync(allOutputsPath).size / 1024 / 1024).toFixed(1)
        const spdMB = (fs.statSync(allSpendsPath).size / 1024 / 1024).toFixed(1)
        log('MERGE', `concat skipped (reusing: outputs=${outMB}MB, spends=${spdMB}MB)`)
    } else {
        log('MERGE', 'concatenating per-worker files')

        const outputFiles = findFiles(dirs.parsed, 'outputs-', '.dat')
        const spendFiles  = findFiles(dirs.parsed, 'spends-', '.dat')
        const metaFiles   = findFiles(dirs.parsed, 'meta-', '.dat')

        log('MERGE', `found ${outputFiles.length} output files, ${spendFiles.length} spend files, ${metaFiles.length} meta files`)

        const outBytes = concatFilesWithHeader(outputFiles, allOutputsPath, HEADER_SIZE)
        const spdBytes = concatFilesWithHeader(spendFiles, allSpendsPath, HEADER_SIZE)
        log('MERGE', `concatenated: outputs=${(outBytes / 1024 / 1024).toFixed(1)}MB, spends=${(spdBytes / 1024 / 1024).toFixed(1)}MB`)

        concatFilesWithHeader(metaFiles, allMetaPath, HEADER_SIZE)
    }
}

// Expected sorted file size = input size minus its header (externalSort
// strips the header from its output). Size alone left a same-size
// stale-artifact window (a sorted file from an earlier run over an
// equally-sized input), so reuse additionally requires the sidecar
// manifest written after a completed sort to match the CURRENT source
// header (see merger/resume-manifest.js). Pre-manifest artifacts are
// simply re-sorted.
function expectedSortedSize(inputPath) {
    return fs.statSync(inputPath).size - HEADER_SIZE
}
function sortedReusable(sortedPath, expSize, sourceHeader, log) {
    if (!(fs.existsSync(sortedPath) && fs.statSync(sortedPath).size === expSize)) return false
    const check = checkSortedManifest(sortedPath, sourceHeader)
    if (!check.ok) log('MERGE', `stale sorted artifact, re-sorting: ${check.reason}`)
    return check.ok
}

// Sort outputs by (txHash8 + vout); returns the sorted file's path.
async function sortOutputs(dirs, allOutputsPath, outputsRecordSize, ramBudgetBytes, log) {
    const sortedOutputsPath = path.join(dirs.merge, 'outputs-sorted.dat')
    const allOutputsHeader = parseDatHeader(allOutputsPath)
    const expOutSize = expectedSortedSize(allOutputsPath)
    if (sortedReusable(sortedOutputsPath, expOutSize, allOutputsHeader, log)) {
        log('MERGE', `sort-outputs skipped (reusing ${(expOutSize / 1024 / 1024).toFixed(1)}MB)`)
    } else {
        log('MERGE', 'sorting outputs by txHash8+vout')
        const outSortResult = await externalSort({
            inputPath:   allOutputsPath,
            outputPath:  sortedOutputsPath,
            recordSize:  outputsRecordSize,
            keySize:     OUTPUTS_KEY_SIZE,
            tmpDir:      dirs.sortTmp,
            headerSize:  HEADER_SIZE,
            ramBudgetBytes,
            onProgress(ev) {
                if (ev.phase === 'sort-done' || ev.phase === 'merge-done') {
                    log('MERGE', `  sort outputs: ${ev.phase} ${JSON.stringify(ev)}`)
                }
            }
        })
        log('MERGE', `outputs sorted: ${outSortResult.recordsSorted} records`)
        writeSortedManifest(sortedOutputsPath, allOutputsHeader)
    }
    return sortedOutputsPath
}

// Sort spends by (prevTxHash8 + prevVout); returns the sorted file's path.
async function sortSpends(dirs, allSpendsPath, ramBudgetBytes, log) {
    const sortedSpendsPath = path.join(dirs.merge, 'spends-sorted.dat')
    const allSpendsHeader = parseDatHeader(allSpendsPath)
    const expSpdSize = expectedSortedSize(allSpendsPath)
    if (sortedReusable(sortedSpendsPath, expSpdSize, allSpendsHeader, log)) {
        log('MERGE', `sort-spends skipped (reusing ${(expSpdSize / 1024 / 1024).toFixed(1)}MB)`)
    } else {
        log('MERGE', 'sorting spends by prevTxHash8+prevVout')
        const spdSortResult = await externalSort({
            inputPath:   allSpendsPath,
            outputPath:  sortedSpendsPath,
            recordSize:  SPENDS_RECORD_SIZE,
            keySize:     SPENDS_KEY_SIZE,
            tmpDir:      dirs.sortTmp,
            headerSize:  HEADER_SIZE,
            ramBudgetBytes,
            onProgress(ev) {
                if (ev.phase === 'sort-done' || ev.phase === 'merge-done') {
                    log('MERGE', `  sort spends: ${ev.phase} ${JSON.stringify(ev)}`)
                }
            }
        })
        log('MERGE', `spends sorted: ${spdSortResult.recordsSorted} records`)
        writeSortedManifest(sortedSpendsPath, allSpendsHeader)
    }
    return sortedSpendsPath
}

// Anti-join: outputs - spends = live UTXOs; returns the live UTXO file's path.
async function antiJoinLiveUtxos(args, dirs, sortedOutputsPath, sortedSpendsPath, outputsRecordSize, log) {
    log('MERGE', 'anti-join: outputs - spends = live UTXOs')
    const liveUtxosPath = path.join(dirs.merge, 'live-utxos.dat')
    const joinResult = await leftAntiJoin({
        leftPath:        sortedOutputsPath,
        rightPath:       sortedSpendsPath,
        outputPath:      liveUtxosPath,
        leftRecordSize:  outputsRecordSize,
        rightRecordSize: SPENDS_RECORD_SIZE,
        keySize:         OUTPUTS_KEY_SIZE,
        leftHeaderSize:  0,   // sorted output has no header (externalSort strips it)
        rightHeaderSize: 0,   // sorted output has no header
        onProgress(ev) {
            if (ev.phase === 'done') log('MERGE', `  anti-join: ${ev.emitted} live, ${ev.canceled} spent, ${ev.orphanSpends} orphan spends`)
        }
    })
    log('MERGE', `live UTXOs: ${joinResult.emitted} (orphan spends: ${joinResult.orphanSpends})`)

    // An orphan spend is a spend whose (prevTxHash8, prevVout) matched no
    // output. With --from > 0 these are expected (spends of pre-range
    // outputs); from genesis they mean the outputs stream is incomplete
    // (missing/partial parsed range) and the DB would silently lack UTXOs.
    if (joinResult.orphanSpends > 0 && args.from === 0) {
        throw new Error(`anti-join found ${joinResult.orphanSpends} orphan spends on a from-genesis run: outputs stream is incomplete, aborting before load`)
    }
    return liveUtxosPath
}

// Derive LevelDB keys, freeing each merge input once the derive step that reads it is done.
async function deriveLevelDbKeys(args, dirs, cleanup, { allMetaPath, allOutputsPath, liveUtxosPath, sortedSpendsPath },
    outputsRecordSize, ramBudgetBytes, log) {
    log('MERGE', 'deriving LevelDB keys')
    const keysResult = await deriveKeys({
        metaPath:         allMetaPath,
        outputsPath:      allOutputsPath,
        liveUtxosPath,
        spendsByPrevPath: sortedSpendsPath,
        outDir:           dirs.keys,
        tmpDir:           dirs.deriveTmp,
        ramBudgetBytes,
        network:          args.network,
        removeSpent:      args.removeSpent,
        outputsRecordSize,
        onProgress(ev) {
            if (ev.phase && ev.phase.includes('done')) {
                log('MERGE', `  derive: ${ev.phase}`)
            }
            // Each phase consumes a specific input. Once it's done, the
            // input is dead weight on disk. Enqueue + maybe-free trades
            // resume capability for ENOSPC safety on tight disks.
            if (ev.phase === 'meta-done') {
                cleanup.enqueue(allMetaPath, 'merge/all-meta.dat')
                cleanup.maybeFree('after derive meta-done')
            } else if (ev.phase === 'live-done') {
                cleanup.enqueue(liveUtxosPath, 'merge/live-utxos.dat')
                cleanup.maybeFree('after derive live-done')
            } else if (ev.phase === 'script-cand-raw-done') {
                cleanup.enqueue(allOutputsPath, 'merge/all-outputs.dat')
                // spends-sorted.dat is only consumed by the I/J phase,
                // which is skipped when removeSpent=true.
                if (args.removeSpent) {
                    cleanup.enqueue(sortedSpendsPath, 'merge/spends-sorted.dat')
                }
                cleanup.maybeFree('after derive script-cand-raw-done')
            } else if (ev.phase === 'spends-done') {
                cleanup.enqueue(sortedSpendsPath, 'merge/spends-sorted.dat')
                cleanup.maybeFree('after derive spends-done')
            }
        }
    })
    log('MERGE', `keys derived: ${JSON.stringify(keysResult.stats)}`)

    return keysResult
}

async function phaseLoad(args, dirs, { log }) {
    log('LOAD', `loading keys into ${args.db}`)
    const result = await loadKeys({
        keysDir:     dirs.keys,
        dbPath:      args.db,
        batchSize:   args.batchSize,
        removeSpent: args.removeSpent,
        onProgress(ev) {
            if (ev.phase === 'prefix-done') {
                log('LOAD', `  ${ev.prefix}: ${ev.count} records (${ev.elapsed_ms}ms)`)
            }
        }
    })
    const total = Object.values(result.stats).reduce((a, b) => a + b, 0)
    log('LOAD', `done: ${total} records in ${result.elapsed_ms}ms`)
    return result
}

module.exports = { phaseDump, phaseParse, phaseMerge, phaseLoad }
