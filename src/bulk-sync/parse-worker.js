#!/usr/bin/env node

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
 * XChain UTXO Tracker - Bulk Sync Parse Worker
 *
 * Reads one .xdmp file (produced by dump.js) and emits three binary
 * intermediate streams (outputs, spends, meta) via the writers in
 * ./writers.js. Stateless, single-threaded, one dump per invocation.
 *
 * Parallelism is achieved by spawning N processes (one per .xdmp)
 * from an external launcher, not inside this worker.
 *
 * Usage:
 *   node src/bulk-sync/parse-worker.js --in <dump.xdmp> --out <dir>
 *
 ********************************************************************/

const fs   = require('fs')
const path = require('path')

const { XdmpReader }     = require('./xdmp-reader.js')
const { processBlock }   = require('./process-block.js')
const {
    OutputsWriter,
    SpendsWriter,
    MetaWriter,
} = require('./writers.js')

const PROGRESS_EVERY_N_BLOCKS = 500

function parseArgs(argv) {
    const args = {}
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i]
        switch (a) {
            case '--in':  args.in  = argv[++i]; break
            case '--out': args.out = argv[++i]; break
            case '--help':
            case '-h':
                printHelp()
                process.exit(0)
            default:
                throw new Error('Unknown argument: ' + a)
        }
    }
    return args
}

function printHelp() {
    console.log(`Usage: node src/bulk-sync/parse-worker.js --in <dump.xdmp> --out <dir>

Reads one .xdmp dump file and emits three intermediate streams:
  outputs-h{FIRST}-h{LAST}.dat
  spends-h{FIRST}-h{LAST}.dat
  meta-h{FIRST}-h{LAST}.dat

Options:
  --in <file>    Path to input .xdmp file (required)
  --out <dir>    Output directory for .dat files (required)
`)
}

function validateArgs(args) {
    if (!args.in)  throw new Error('--in is required')
    if (!args.out) throw new Error('--out is required')
    if (!fs.existsSync(args.in)) throw new Error(`input file does not exist: ${args.in}`)
}

function fmtDuration(ms) {
    const s   = Math.floor(ms / 1000)
    const h   = Math.floor(s / 3600)
    const m   = Math.floor((s % 3600) / 60)
    const sec = s % 60
    return `${h}h${String(m).padStart(2, '0')}m${String(sec).padStart(2, '0')}s`
}

function fmtMB(bytes) {
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

function h8(n) {
    return String(n).padStart(8, '0')
}

function outPaths(outDir, firstHeight, lastHeight) {
    const suffix = `h${h8(firstHeight)}-h${h8(lastHeight)}.dat`
    return {
        outputs: path.join(outDir, `outputs-${suffix}`),
        spends:  path.join(outDir, `spends-${suffix}`),
        meta:    path.join(outDir, `meta-${suffix}`),
    }
}

/**
 * Header sanity for an existing intermediate .dat: record_count (offset 20,
 * u64 LE) must be non-zero (SPEC: 0 = crashed/partial worker), and for
 * fixed-record streams (record_size at offset 28 non-zero) the file size must
 * equal header + count * record_size. Variable streams (meta, record_size 0)
 * only get the count check.
 */
function existingDatLooksComplete(filePath) {
    if (!fs.existsSync(filePath)) return false
    let fd
    try {
        fd = fs.openSync(filePath, 'r')
        const hdr = Buffer.alloc(64)
        if (fs.readSync(fd, hdr, 0, 64, 0) !== 64) return false
        const count      = hdr.readBigUInt64LE(20)
        const recordSize = hdr.readUInt32LE(28)
        const size       = BigInt(fs.fstatSync(fd).size)
        if (recordSize > 0) {
            // count 0 with a header-only size is a legitimately empty stream
            // (e.g. no spends in the range); count 0 with data is a crash.
            return size === 64n + count * BigInt(recordSize)
        }
        // Variable-length stream (meta): every range has blocks, so count 0
        // is always the crash sentinel.
        return count !== 0n
    } catch (_) {
        return false
    } finally {
        if (fd !== undefined) { try { fs.closeSync(fd) } catch (_) {} }
    }
}

function main() {
    const args = parseArgs(process.argv)
    validateArgs(args)

    if (!fs.existsSync(args.out)) {
        fs.mkdirSync(args.out, { recursive: true })
    }

    const reader  = new XdmpReader(args.in)
    const paths   = outPaths(args.out, reader.firstHeight, reader.lastHeight)

    console.log(`[parse-worker] in=${args.in}`)
    console.log(`[parse-worker] chain=${reader.chain}-${reader.network}, heights ${reader.firstHeight}..${reader.lastHeight} (${reader.blockCount} blocks)`)
    console.log(`[parse-worker] out=${args.out}`)

    // Skip if all three outputs already exist AND each passes the header
    // sanity check (record_count != 0 is the SPEC's crashed-worker sentinel;
    // for fixed-record streams the size must match count * record_size).
    // Existence alone would resurrect a partial file from a crashed run.
    if (existingDatLooksComplete(paths.outputs) &&
        existingDatLooksComplete(paths.spends) &&
        existingDatLooksComplete(paths.meta)) {
        console.log(`[parse-worker] all outputs already exist for this range, skipping`)
        reader.close()
        return
    }

    // Lazy require so --help works without bitcoinjs-lib installed.
    const XChainBlockDecoder = require('../XChainBlockDecoder.js')
    const decoder = new XChainBlockDecoder(`${reader.chain}-${reader.network}`)

    const outputs = new OutputsWriter(paths.outputs, reader.chain, reader.network, reader.firstHeight, reader.lastHeight)
    const spends  = new SpendsWriter(paths.spends,   reader.chain, reader.network, reader.firstHeight, reader.lastHeight)
    const meta    = new MetaWriter(paths.meta,       reader.chain, reader.network, reader.firstHeight, reader.lastHeight)
    const writers = { outputs, spends, meta }

    const startedAt        = Date.now()
    let   lastTickAt       = startedAt
    let   lastTickBlocks   = 0
    let   totalBlocks      = 0
    let   totalTxs         = 0
    let   totalOutputs     = 0
    let   totalSpends      = 0
    let   lastHeightSeen   = -1

    try {
        for (const { height, blockHash, blockBytes } of reader.blocks()) {
            lastHeightSeen = height
            const block = decoder.blockFromBuffer(blockBytes)
            const stats = processBlock(block, height, blockHash, writers)

            totalBlocks++
            totalTxs     += stats.txs
            totalOutputs += stats.outputs
            totalSpends  += stats.spends

            if (totalBlocks % PROGRESS_EVERY_N_BLOCKS === 0) {
                const now        = Date.now()
                const sinceTick  = (now - lastTickAt) / 1000
                const blocksTick = totalBlocks - lastTickBlocks
                const instRate   = sinceTick > 0 ? (blocksTick / sinceTick).toFixed(1) : 'n/a'
                const avgRate    = ((totalBlocks * 1000) / (now - startedAt)).toFixed(1)
                const remaining  = reader.blockCount - totalBlocks
                const etaSec     = Number(avgRate) > 0 ? Math.round(remaining / Number(avgRate)) : -1
                const etaStr     = etaSec >= 0 ? fmtDuration(etaSec * 1000) : '?'
                console.log(
                    `[parse-worker] h=${height} blocks=${totalBlocks}/${reader.blockCount}` +
                    ` outputs=${totalOutputs} spends=${totalSpends}` +
                    ` rate=${instRate} blk/s avg=${avgRate} blk/s eta=${etaStr}`
                )
                lastTickAt     = now
                lastTickBlocks = totalBlocks
            }
        }
    } catch (err) {
        console.error(`[parse-worker] FATAL at height=${lastHeightSeen}: ${err.message}`)
        if (err.stack) console.error(err.stack)
        outputs.abort()
        spends.abort()
        meta.abort()
        reader.close()
        process.exit(1)
    }

    outputs.close()
    spends.close()
    meta.close()
    reader.close()

    const elapsed = Date.now() - startedAt
    const outputsStat = fs.statSync(paths.outputs)
    const spendsStat  = fs.statSync(paths.spends)
    const metaStat    = fs.statSync(paths.meta)

    console.log(`[parse-worker] done:`)
    console.log(`  blocks=${totalBlocks} txs=${totalTxs} outputs=${totalOutputs} spends=${totalSpends}`)
    console.log(`  outputs=${fmtMB(outputsStat.size)}  spends=${fmtMB(spendsStat.size)}  meta=${fmtMB(metaStat.size)}`)
    console.log(`  duration=${fmtDuration(elapsed)} rate=${((totalBlocks * 1000) / elapsed).toFixed(1)} blk/s`)
}

module.exports = { existingDatLooksComplete }

if (require.main === module) {
    try {
        main()
    } catch (err) {
        console.error('[parse-worker] FATAL:', err.message)
        if (err.stack) console.error(err.stack)
        process.exit(1)
    }
}
