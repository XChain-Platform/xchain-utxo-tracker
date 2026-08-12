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
 **********************************************************************
 *
 * XChain UTXO Tracker - Bulk Sync Orchestrator
 *
 * Chains the full pipeline: dump → parse → merge → load.
 *
 * Usage:
 *   node orchestrator.js --network bitcoin-regtest --out /tmp/bulk-sync \
 *       --db /tmp/candidate-db [options]
 *
 * Requires NODE_URL, NODE_PORT, NODE_USER, NODE_PASSWORD env vars
 * (passed through to dump.js).
 *
 ********************************************************************/

const fs             = require('fs')
const path           = require('path')
const { fork }       = require('child_process')
const { externalSort }  = require('./merger/external-sort.js')
const { leftAntiJoin }  = require('./merger/streaming-join.js')
const { deriveKeys, resolveUndoBlocks } = require('./merger/derive-keys.js')
const { loadKeys }      = require('./merger/loader.js')
const { validateChainFiles } = require('./validate-chain.js')
const { HEADER_SIZE, OUTPUTS_RECORD_SIZE, SPENDS_RECORD_SIZE } = require('./writers.js')
const { networkToCodes, validateConcatArtifact, parseDatHeader,
        writeSortedManifest, checkSortedManifest } = require('./merger/resume-manifest.js')

// --------------- constants ---------------

const OUTPUTS_KEY_SIZE = 12   // txHash8(8) + vout(4)
const SPENDS_KEY_SIZE  = 12   // prevTxHash8(8) + prevVout(4)

const BULK_SYNC_DIR = __dirname

// --------------- cleanup manager ---------------

/**
 * Tracks files that have been fully consumed by the pipeline and unlinks
 * them on demand when free disk space drops below a threshold. Keeping the
 * files when there's room preserves resume points (phaseMerge's existsSync
 * guards); deleting them under pressure prevents ENOSPC during the next
 * sort/scratch spike.
 */
class CleanupManager {
    constructor(workDir, thresholdMb) {
        this.workDir       = workDir
        this.thresholdBytes = (thresholdMb | 0) * 1024 * 1024
        this.queue         = []
    }

    freeBytes() {
        try {
            const s = fs.statfsSync(this.workDir)
            return Number(s.bavail) * Number(s.bsize)
        } catch (_) {
            return Number.POSITIVE_INFINITY
        }
    }

    enqueue(filePath, label) {
        if (!filePath) return
        if (!fs.existsSync(filePath)) return
        this.queue.push({ filePath, label: label || path.basename(filePath) })
    }

    maybeFree(reason) {
        if (this.thresholdBytes <= 0) return
        const before = this.freeBytes()
        if (before >= this.thresholdBytes) return
        log('CLEANUP', `disk low (${(before / 1e9).toFixed(1)}GB free, threshold ${(this.thresholdBytes / 1e9).toFixed(1)}GB): ${reason}`)
        let freedBytes = 0
        while (this.queue.length > 0 && this.freeBytes() < this.thresholdBytes) {
            const { filePath, label } = this.queue.shift()
            try {
                const sz = fs.statSync(filePath).size
                fs.unlinkSync(filePath)
                freedBytes += sz
                log('CLEANUP', `  unlinked ${label} (${(sz / 1e9).toFixed(1)}GB)`)
            } catch (err) {
                log('CLEANUP', `  failed to unlink ${label}: ${err.message}`)
            }
        }
        const after = this.freeBytes()
        log('CLEANUP', `  done: freed ${(freedBytes / 1e9).toFixed(1)}GB, now ${(after / 1e9).toFixed(1)}GB free, queue=${this.queue.length}`)
    }
}

// --------------- arg parsing ---------------

function parseArgs(argv) {
    const args = {
        network:    null,
        from:       0,
        to:         null,      // null = use tip - tipSafety
        tipSafety:  10,
        // Named opt-in for the one unsafe shape effectiveTipSafety cannot clamp: an
        // explicit --to inside the live undo window. Threaded to dump.js, which is
        // where the real tip is known and where the guard actually runs (#4634).
        allowUndoWindow: false,
        chunkSize:  10000,
        out:        null,      // working directory for all artifacts
        db:         null,      // final DB path (classic-level / LevelDB)
        workers:    null,      // null = auto (number of dump chunks)
        ramBudget:  1024,      // MB for external sort
        batchSize:  10000,     // loader batch size
        // Free consumed merge/ files when free disk drops below this many MB.
        // 0 disables cleanup (preserves all resume points). Default 100 GB:
        // generous enough that runs with comfortable disk keep their resume
        // files, but trips before the next sort can ENOSPC on a tight disk.
        cleanupThresholdMb: 100 * 1024,
        skipDump:    false,
        // null = unset; resolveVerifyDefaults() turns null into ON for
        // mainnet networks (safety over read-pass cost, ) and OFF
        // everywhere else. Explicit --[no-]verify-* flags always win.
        verifyChain: null,
        verifyMerkle: null,    // implies verifyChain; adds tx-body merkle rebuild
        skipParse:   false,
        // Default matches XChainUtxoTracker.REMOVE_SPENT = true. Skipping
        // I/J cuts ~130 GB of disk and ~30-60 min on mainnet because the
        // live tracker never persists those records anyway.
        removeSpent: true,
    }
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i]
        switch (arg) {
            case '--network':         args.network     = argv[++i]; break
            case '--from':            args.from        = parseInt(argv[++i], 10); break
            case '--to':              args.to          = parseInt(argv[++i], 10); break
            case '--tip-safety':      args.tipSafety   = parseInt(argv[++i], 10); break
            case '--allow-undo-window': args.allowUndoWindow = true; break
            case '--chunk-size':      args.chunkSize   = parseInt(argv[++i], 10); break
            case '--out':             args.out         = argv[++i]; break
            case '--db':              args.db          = argv[++i]; break
            // Legacy backend flag (the only backend now is classic-level).
            // Accepted (and ignored) so older invocations don't error out.
            case '--backend':         i++; break
            case '--workers':         args.workers     = parseInt(argv[++i], 10); break
            case '--ram-budget':      args.ramBudget   = parseInt(argv[++i], 10); break
            case '--batch-size':      args.batchSize   = parseInt(argv[++i], 10); break
            case '--cleanup-threshold-mb': args.cleanupThresholdMb = parseInt(argv[++i], 10); break
            case '--skip-dump':       args.skipDump    = true; break
            case '--verify-chain':     args.verifyChain  = true;  break
            case '--no-verify-chain':  args.verifyChain  = false; break
            case '--verify-merkle':    args.verifyMerkle = true;  break
            case '--no-verify-merkle': args.verifyMerkle = false; break
            case '--skip-parse':      args.skipParse   = true; break
            case '--remove-spent':    args.removeSpent = true; break
            case '--no-remove-spent': args.removeSpent = false; break
            default:
                if (arg === '--help' || arg === '-h') {
                    printUsage()
                    process.exit(0)
                }
                throw new Error(`unknown arg: ${arg}`)
        }
    }
    if (!args.network) throw new Error('--network is required')
    if (!args.out)     throw new Error('--out is required')
    if (!args.db)      throw new Error('--db is required')
    resolveVerifyDefaults(args)
    return args
}

// A mainnet bootstrap seeds the production UTXO set, so a silently corrupt
// dump (truncated .xdmp, disk bitrot, node fed a bad block) is a
// consensus-facing hazard: verification defaults ON there .
// Non-mainnet (regtest/testnet) keeps the fast path.
function isMainnetNetwork(network) {
    return /-mainnet$/.test(String(network))
}

// Resolve null (unset) verify flags per network, then enforce the
// merkle-implies-chain invariant: merkle verification walks the header
// chain anyway, so verifyMerkle without verifyChain is not a real mode.
function resolveVerifyDefaults(args) {
    const mainnet = isMainnetNetwork(args.network)
    if (args.verifyMerkle === null) args.verifyMerkle = mainnet
    if (args.verifyChain  === null) args.verifyChain  = mainnet
    if (args.verifyMerkle) args.verifyChain = true
    return args
}

// Reorg-recovery invariant (SPEC.md: "The `K` and `M` reorg-recovery reverse indices are
// skipped entirely. The `W` creation-block reverse index IS seeded"): the merger emits no
// K/M reorg-recovery indices, so any block bulk-sync seeds directly is un-recoverable on
// reorg. W alone is not enough, and it is itself only seeded for the windowed range
// derive-keys emits. The design stops bulk-sync at least undoBlocks below the tip and lets
// the live incremental worker build W/K/M for every block inside the reorg
// window. With tip-safety < undoBlocks the seeded N-window includes bulk-synced blocks
// with no K/M, so a reorg into that range leaves phantom (unspent, never-deleted) or
// missing (spent, never-restored) UTXOs until a full re-index (#4634). When --to is not
// pinned we clamp tip-safety up to undoBlocks (the same per-chain value derive-keys uses
// to size the N-window, so the stop point and the seeded window stay in lockstep). Clamp
// up only: an operator may choose a LARGER margin, never a smaller one. An explicit --to
// is returned as-is because the tip is unknown here and the clamp has nothing to compare
// against; the invariant is enforced instead in dump.js, at the one point the real tip IS
// resolved, where an explicit --to inside the undo window is rejected unless
// --allow-undo-window names the override (). Warning-only here was not enough.
function effectiveTipSafety(tipSafety, to, network) {
    if (to !== null) return tipSafety
    return Math.max(tipSafety, resolveUndoBlocks(network))
}

function printUsage() {
    console.log(`
Usage: node orchestrator.js [options]

Required:
  --network <name>      e.g. bitcoin-regtest, bitcoin-mainnet
  --out <dir>           working directory for all artifacts
  --db <path>           final DB directory

Options:
  --from <height>       first block (default 0)
  --to <height>         last block (default: tip - tip-safety)
  --tip-safety <n>      blocks before tip to stop (default 10)
  --allow-undo-window   permit an explicit --to inside the live undo window
                        (unsafe: no K/M reorg-recovery indices are seeded there)
  --chunk-size <n>      blocks per .xdmp file (default 10000)
  --workers <n>         parallel parse workers (default: number of chunks)
  --ram-budget <MB>     RAM for external sort (default 1024)
  --batch-size <n>      loader batch size (default 10000)
  --cleanup-threshold-mb <MB>
                        free consumed merge/ files when free disk drops below
                        this threshold (default 102400 = 100 GB; 0 disables)
  --skip-dump           skip dump phase (reuse existing .xdmp files)
  --verify-chain        recompute each block hash and check prevHash linkage
                        across the dump before parsing (fail-loud on a break)
  --verify-merkle       --verify-chain plus rebuild every block's merkle root
                        from its tx bytes (full block-body integrity; parses
                        every transaction, so the gate pass is slower)
                        Both verifications default ON for *-mainnet networks
                        and OFF elsewhere.
  --no-verify-chain     opt out of chain verification (mainnet: also pass
                        --no-verify-merkle, since merkle implies chain)
  --no-verify-merkle    opt out of merkle verification
  --skip-parse          skip dump+parse phases (reuse existing .dat files)
  --no-remove-spent     force emission of I/J prefixes (default: skip them
                        to match XChainUtxoTracker.REMOVE_SPENT=true)

Environment:
  NODE_URL, NODE_PORT, NODE_USER, NODE_PASSWORD (coin node RPC)
`)
}

// --------------- helpers ---------------

function fmtDuration(ms) {
    const s = Math.floor(ms / 1000)
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = s % 60
    return `${String(h).padStart(2, '0')}h${String(m).padStart(2, '0')}m${String(sec).padStart(2, '0')}s`
}

function log(phase, msg) {
    const ts = new Date().toISOString().slice(11, 19)
    console.log(`[${ts}] [${phase}] ${msg}`)
}

/**
 * Spawn a child process (fork) and return a promise that resolves on exit 0.
 */
function runChild(scriptPath, args, env) {
    return new Promise((resolve, reject) => {
        const child = fork(scriptPath, args, {
            stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
            env: { ...process.env, ...env },
        })
        child.on('exit', (code) => {
            if (code === 0) resolve()
            else reject(new Error(`${path.basename(scriptPath)} exited with code ${code}`))
        })
        child.on('error', reject)
    })
}

/**
 * Concatenate multiple binary files into one, keeping the header from the
 * first file and stripping it from subsequent files. Downstream readers
 * (RecordReader, MetaReader, deriveKeys) expect a single header.
 *
 * After concatenation, patches the output header so its record_count (offset
 * 20, u64 LE) equals the sum of record_count across inputs, and its
 * lastHeight (offset 16, u32 LE) equals the max across inputs. Without this
 * MetaReader rejects the concatenated file when it contains records from
 * more than one input.
 *
 * Returns total bytes written (including the one header).
 */
function concatFilesWithHeader(inputPaths, outputPath, headerSize) {
    if (inputPaths.length === 0) throw new Error('concatFilesWithHeader: no input files')

    const hdrBuf = Buffer.alloc(headerSize)
    let totalRecordCount = 0n
    let maxLastHeight = 0
    let firstHdr = null       // magic/chain/net/record_size of the first input
    let prevLastHeight = null // cross-file contiguity check

    // Write to a .tmp and rename only after the header patch, so a crashed
    // concat can never satisfy phaseMerge's existence-based resume guard with
    // a half-written (or first-input-header-only) file.
    const tmpPath = outputPath + '.tmp'
    const fd = fs.openSync(tmpPath, 'w+')
    const BUF_SIZE = 256 * 1024
    const buf = Buffer.alloc(BUF_SIZE)
    let totalBytes = 0
    try {
        for (let i = 0; i < inputPaths.length; i++) {
            const stat = fs.statSync(inputPaths[i])
            const fdIn = fs.openSync(inputPaths[i], 'r')
            try {
                // Read this input's header to aggregate record_count + lastHeight.
                if (stat.size < headerSize) {
                    throw new Error(`${inputPaths[i]} is smaller than headerSize ${headerSize}`)
                }
                let hRead = 0
                while (hRead < headerSize) {
                    const n = fs.readSync(fdIn, hdrBuf, hRead, headerSize - hRead, hRead)
                    if (n === 0) throw new Error(`short header read in ${inputPaths[i]}`)
                    hRead += n
                }

                // Every input must agree on magic, chain, net and record_size.
                // Mixed record widths (legacy 120B vs coinbase-flagged 121B
                // outputs surviving a resume across a code upgrade) would
                // misframe every record after the first width transition, and
                // the sort's divisibility check cannot always catch it.
                const thisHdr = {
                    magic:      hdrBuf.toString('ascii', 0, 8),
                    chain:      hdrBuf.readUInt8(8),
                    net:        hdrBuf.readUInt8(9),
                    recordSize: hdrBuf.readUInt32LE(28),
                }
                const recordCount = hdrBuf.readBigUInt64LE(20)
                const firstH      = hdrBuf.readUInt32LE(12)
                const lastH       = hdrBuf.readUInt32LE(16)
                if (recordCount === 0n && stat.size !== headerSize) {
                    // SPEC: count 0 marks a crashed/partial worker file (data
                    // present, backfill never ran). A header-only file with
                    // count 0 is a legitimately empty stream (e.g. a spends
                    // range with no non-coinbase inputs).
                    throw new Error(`${inputPaths[i]} has record_count 0 but ${stat.size} bytes (crashed/partial worker output); re-run the parse for this range`)
                }
                if (firstHdr === null) {
                    firstHdr = thisHdr
                } else {
                    for (const f of ['magic', 'chain', 'net', 'recordSize']) {
                        if (thisHdr[f] !== firstHdr[f]) {
                            throw new Error(`${inputPaths[i]} header ${f}=${thisHdr[f]} differs from first input's ${firstHdr[f]}; refusing to concatenate mixed files`)
                        }
                    }
                    if (prevLastHeight !== null && firstH !== prevLastHeight + 1) {
                        throw new Error(`${inputPaths[i]} starts at height ${firstH}, expected ${prevLastHeight + 1} (gap or overlap in parsed ranges)`)
                    }
                }
                prevLastHeight = lastH

                totalRecordCount += recordCount
                if (lastH > maxLastHeight) maxLastHeight = lastH

                // First file: copy entirely. Others: skip header.
                let pos = (i === 0) ? 0 : headerSize
                while (pos < stat.size) {
                    const toRead = Math.min(BUF_SIZE, stat.size - pos)
                    const n = fs.readSync(fdIn, buf, 0, toRead, pos)
                    if (n === 0) throw new Error(`short read in ${inputPaths[i]} at offset ${pos} (file shrank mid-copy?)`)
                    fs.writeSync(fd, buf, 0, n)
                    totalBytes += n
                    pos += n
                }
                if (pos !== stat.size) {
                    throw new Error(`${inputPaths[i]}: copied ${pos} of ${stat.size} bytes`)
                }
            } finally {
                fs.closeSync(fdIn)
            }
        }

        // Patch aggregated record_count (offset 20, u64 LE) and lastHeight
        // (offset 16, u32 LE) into the output header.
        const patch = Buffer.alloc(8)
        patch.writeUInt32LE(maxLastHeight, 0)
        fs.writeSync(fd, patch, 0, 4, 16)
        patch.writeBigUInt64LE(totalRecordCount, 0)
        fs.writeSync(fd, patch, 0, 8, 20)
        fs.fsyncSync(fd)
    } catch (err) {
        try { fs.closeSync(fd) } catch (_) {}
        try { fs.unlinkSync(tmpPath) } catch (_) {}
        throw err
    }
    fs.closeSync(fd)
    fs.renameSync(tmpPath, outputPath)
    return totalBytes
}

/**
 * Read the record_size field (offset 28, u32 LE) from a dump/intermediate
 * header. This is the explicit width discriminator between the legacy 120-byte
 * outputs record and the 121-byte coinbase-flagged record (L-4). Falls back to
 * the compiled OUTPUTS_RECORD_SIZE if the field is absent (0) or unreadable, so
 * a pre-record_size dump still parses at the current width.
 */
function readOutputsRecordSize(filePath) {
    let fd
    try {
        fd = fs.openSync(filePath, 'r')
        const buf = Buffer.alloc(4)
        const n = fs.readSync(fd, buf, 0, 4, 28)
        if (n < 4) return OUTPUTS_RECORD_SIZE
        const rs = buf.readUInt32LE(0)
        return rs > 0 ? rs : OUTPUTS_RECORD_SIZE
    } catch (_) {
        return OUTPUTS_RECORD_SIZE
    } finally {
        if (fd !== undefined) { try { fs.closeSync(fd) } catch (_) {} }
    }
}

/**
 * Find files matching a glob-like prefix+suffix in a directory.
 * Returns paths sorted by name (which sorts by height range).
 */
function findFiles(dir, prefix, suffix) {
    return fs.readdirSync(dir)
        .filter(f => f.startsWith(prefix) && f.endsWith(suffix))
        .sort()
        .map(f => path.join(dir, f))
}

// --------------- phases ---------------

async function phaseDump(args, dirs) {
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
        // rides along, so the override has to reach the child (#4634, ).
        if (args.allowUndoWindow) dumpArgs.push('--allow-undo-window')
    } else {
        dumpArgs.push('--tip-safety', String(args.tipSafety))
    }
    await runChild(path.join(BULK_SYNC_DIR, 'dump.js'), dumpArgs)
    const xdmpFiles = findFiles(dirs.dumps, 'blocks-', '.xdmp')
    log('DUMP', `done: ${xdmpFiles.length} .xdmp files`)
    return xdmpFiles
}

async function phaseParse(args, dirs, xdmpFiles) {
    const maxWorkers = args.workers || xdmpFiles.length
    log('PARSE', `parsing ${xdmpFiles.length} dumps with up to ${maxWorkers} parallel workers`)

    // Process in batches of maxWorkers
    for (let i = 0; i < xdmpFiles.length; i += maxWorkers) {
        const batch = xdmpFiles.slice(i, i + maxWorkers)
        const promises = batch.map(xdmpPath => {
            const parseArgs = ['--in', xdmpPath, '--out', dirs.parsed]
            return runChild(path.join(BULK_SYNC_DIR, 'parse-worker.js'), parseArgs)
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

async function phaseMerge(args, dirs, cleanup) {
    const allOutputsPath = path.join(dirs.merge, 'all-outputs.dat')
    const allSpendsPath  = path.join(dirs.merge, 'all-spends.dat')
    const allMetaPath    = path.join(dirs.merge, 'all-meta.dat')

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

    const ramBudgetBytes = args.ramBudget * 1024 * 1024

    // The dump header's record_size field (offset 28, u32 LE) is the explicit
    // format discriminator: new dumps report 121 (trailing coinbase flag, L-4),
    // legacy dumps report 120. Threading it through the sort, anti-join and
    // deriveKeys lets both widths merge; a legacy dump carries no flag and its
    // outputs are treated as non-coinbase. Fall back to the compiled constant if
    // the field is absent (0), so a pre-record_size dump still parses.
    const outputsRecordSize = readOutputsRecordSize(allOutputsPath)
    log('MERGE', `outputs record size = ${outputsRecordSize}B (${outputsRecordSize === OUTPUTS_RECORD_SIZE ? 'coinbase-flagged' : 'legacy'})`)

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
    function sortedReusable(sortedPath, expSize, sourceHeader) {
        if (!(fs.existsSync(sortedPath) && fs.statSync(sortedPath).size === expSize)) return false
        const check = checkSortedManifest(sortedPath, sourceHeader)
        if (!check.ok) log('MERGE', `stale sorted artifact, re-sorting: ${check.reason}`)
        return check.ok
    }

    // Sort outputs by (txHash8 + vout)
    const sortedOutputsPath = path.join(dirs.merge, 'outputs-sorted.dat')
    const allOutputsHeader = parseDatHeader(allOutputsPath)
    const expOutSize = expectedSortedSize(allOutputsPath)
    if (sortedReusable(sortedOutputsPath, expOutSize, allOutputsHeader)) {
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

    // Sort spends by (prevTxHash8 + prevVout)
    const sortedSpendsPath = path.join(dirs.merge, 'spends-sorted.dat')
    const allSpendsHeader = parseDatHeader(allSpendsPath)
    const expSpdSize = expectedSortedSize(allSpendsPath)
    if (sortedReusable(sortedSpendsPath, expSpdSize, allSpendsHeader)) {
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

    // all-spends.dat is no longer read after spends-sorted.dat is built.
    cleanup.enqueue(allSpendsPath, 'merge/all-spends.dat')
    cleanup.maybeFree('after sort-spends')

    // Anti-join: outputs - spends = live UTXOs
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

    // outputs-sorted.dat is only read by the anti-join above.
    cleanup.enqueue(sortedOutputsPath, 'merge/outputs-sorted.dat')
    cleanup.maybeFree('after anti-join')

    // Derive LevelDB keys
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

async function phaseLoad(args, dirs) {
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

// --------------- main ---------------

async function main() {
    const args = parseArgs(process.argv)

    // Setup directory structure
    const dirs = {
        dumps:     path.join(args.out, 'dumps'),
        parsed:    path.join(args.out, 'parsed'),
        merge:     path.join(args.out, 'merge'),
        sortTmp:   path.join(args.out, 'merge', 'sort-tmp'),
        deriveTmp: path.join(args.out, 'merge', 'derive-tmp'),
        keys:      path.join(args.out, 'keys'),
    }
    for (const d of Object.values(dirs)) {
        fs.mkdirSync(d, { recursive: true })
    }

    const t0 = Date.now()

    log('ORCHESTRATOR', `network=${args.network} from=${args.from} removeSpent=${args.removeSpent}`)
    log('ORCHESTRATOR', `out=${args.out} db=${args.db}`)
    log('ORCHESTRATOR', `cleanup-threshold=${args.cleanupThresholdMb}MB ${args.cleanupThresholdMb > 0 ? '(enabled)' : '(disabled)'}`)

    // Enforce the reorg-recovery invariant before the dump phase reads tip-safety
    // (see effectiveTipSafety): clamp tip-safety up to undoBlocks so no bulk-seeded
    // block lands inside the active reorg window with no K/M indices (#4634).
    const undoBlocks = resolveUndoBlocks(args.network)
    const clampedTipSafety = effectiveTipSafety(args.tipSafety, args.to, args.network)
    if (args.to !== null) {
        log('ORCHESTRATOR', `explicit --to ${args.to} set: dump.js rejects it if it exceeds tip-${undoBlocks}${args.allowUndoWindow ? ', but --allow-undo-window overrides that guard' : ''}, since a reorg into the bulk range finds no K/M reorg-recovery indices (#4634)`)
    } else if (clampedTipSafety !== args.tipSafety) {
        log('ORCHESTRATOR', `tip-safety ${args.tipSafety} < undo-blocks ${undoBlocks} for ${args.network}; raising tip-safety to ${clampedTipSafety} so the reorg window stays inside the live-built W/K/M range (#4634)`)
        args.tipSafety = clampedTipSafety
    }

    const cleanup = new CleanupManager(args.out, args.cleanupThresholdMb)

    // Phase 1: Dump
    let xdmpFiles
    if (args.skipParse || args.skipDump) {
        xdmpFiles = findFiles(dirs.dumps, 'blocks-', '.xdmp')
        log('DUMP', `skipped (reusing ${xdmpFiles.length} existing .xdmp files)`)
    } else {
        xdmpFiles = await phaseDump(args, dirs)
    }

    // Phase 1.5: optional chain-continuity gate. Off by default (adds a full
    // read pass over the dump); when on, recompute every block hash and confirm
    // prevHash linkage before committing CPU to parse/merge, so a Byzantine node
    // or a corrupted .xdmp fails the bootstrap loudly instead of poisoning the DB.
    if (args.verifyChain) {
        log('VERIFY', `checking chain continuity across ${xdmpFiles.length} .xdmp files${args.verifyMerkle ? ' (headers + merkle roots)' : ''}`)
        const res = validateChainFiles(xdmpFiles, { merkle: args.verifyMerkle })
        if (!res.ok) {
            throw new Error(`chain-continuity check failed after ${res.blocksChecked} blocks: ${res.error}`)
        }
        log('VERIFY', `OK: ${res.blocksChecked} blocks, heights ${res.firstHeight}..${res.lastHeight}`)
    }

    // Phase 2: Parse
    if (args.skipParse) {
        log('PARSE', 'skipped (reusing existing .dat files)')
    } else {
        await phaseParse(args, dirs, xdmpFiles)
    }

    // Phase 3: Merge
    const mergeResult = await phaseMerge(args, dirs, cleanup)

    // Phase 4: Load
    const loadResult = await phaseLoad(args, dirs)

    const elapsed = Date.now() - t0
    log('ORCHESTRATOR', `pipeline complete in ${fmtDuration(elapsed)}`)
    log('ORCHESTRATOR', `DB at ${args.db}: ready for validate-db`)
}

// Export pure helpers for unit testing; only auto-run the pipeline when invoked
// directly (node orchestrator.js), not when required by a test.
module.exports = { parseArgs, effectiveTipSafety, resolveUndoBlocks, readOutputsRecordSize, concatFilesWithHeader, resolveVerifyDefaults, isMainnetNetwork }

if (require.main === module) {
    main().catch(err => {
        console.error('[orchestrator] FATAL:', err.message)
        if (err.stack) console.error(err.stack)
        process.exit(1)
    })
}
