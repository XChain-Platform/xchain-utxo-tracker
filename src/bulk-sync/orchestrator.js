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
const { resolveUndoBlocks } = require('./merger/derive_keys.js')
const { validateChainFiles } = require('./validate_chain.js')
const { defaultArgs, isMainnetNetwork, resolveVerifyDefaults, effectiveTipSafety } = require('./orchestrator/cli_options.js')
const { fmtDuration, concatFilesWithHeader, readOutputsRecordSize, findFiles } = require('./orchestrator/file_ops.js')
const { phaseDump, phaseParse, phaseMerge, phaseLoad } = require('./orchestrator/phases.js')

// cleanup manager

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

// arg parsing

function parseArgs(argv) {
    const args = defaultArgs()
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

// process output and child spawns stay in this entry: the phases receive them

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

// main

async function main() {
    const args = parseArgs(process.argv)
    const dirs = createWorkDirs(args)

    const t0 = Date.now()

    log('ORCHESTRATOR', `network=${args.network} from=${args.from} removeSpent=${args.removeSpent}`)
    log('ORCHESTRATOR', `out=${args.out} db=${args.db}`)
    log('ORCHESTRATOR', `cleanup-threshold=${args.cleanupThresholdMb}MB ${args.cleanupThresholdMb > 0 ? '(enabled)' : '(disabled)'}`)

    clampTipSafety(args)

    const cleanup = new CleanupManager(args.out, args.cleanupThresholdMb)
    const io = { log, runChild }

    // Phase 1: Dump
    let xdmpFiles
    if (args.skipParse || args.skipDump) {
        xdmpFiles = findFiles(dirs.dumps, 'blocks-', '.xdmp')
        log('DUMP', `skipped (reusing ${xdmpFiles.length} existing .xdmp files)`)
    } else {
        xdmpFiles = await phaseDump(args, dirs, io)
    }

    verifyDumpChain(args, xdmpFiles)

    // Phase 2: Parse
    if (args.skipParse) {
        log('PARSE', 'skipped (reusing existing .dat files)')
    } else {
        await phaseParse(args, dirs, xdmpFiles, io)
    }

    // Phase 3: Merge
    const mergeResult = await phaseMerge(args, dirs, cleanup, io)

    // Phase 4: Load
    const loadResult = await phaseLoad(args, dirs, io)

    const elapsed = Date.now() - t0
    log('ORCHESTRATOR', `pipeline complete in ${fmtDuration(elapsed)}`)
    log('ORCHESTRATOR', `DB at ${args.db}: ready for validate-db`)
}

function createWorkDirs(args) {
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
    return dirs
}

function clampTipSafety(args) {
    // Enforce the reorg-recovery invariant before the dump phase reads tip-safety
    // (see effectiveTipSafety): clamp tip-safety up to undoBlocks so no bulk-seeded
    // block lands inside the active reorg window with no K/M indices.
    const undoBlocks = resolveUndoBlocks(args.network)
    const clampedTipSafety = effectiveTipSafety(args.tipSafety, args.to, args.network)
    if (args.to !== null) {
        log('ORCHESTRATOR', `explicit --to ${args.to} set: dump.js rejects it if it exceeds tip-${undoBlocks}${args.allowUndoWindow ? ', but --allow-undo-window overrides that guard' : ''}, since a reorg into the bulk range finds no K/M reorg-recovery indices`)
    } else if (clampedTipSafety !== args.tipSafety) {
        log('ORCHESTRATOR', `tip-safety ${args.tipSafety} < undo-blocks ${undoBlocks} for ${args.network}; raising tip-safety to ${clampedTipSafety} so the reorg window stays inside the live-built W/K/M range`)
        args.tipSafety = clampedTipSafety
    }
}

function verifyDumpChain(args, xdmpFiles) {
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
