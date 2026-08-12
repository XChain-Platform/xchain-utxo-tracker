#!/usr/bin/env node
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
 * XChain UTXO Tracker - Bulk Sync Block Dumper
 *
 * Dumps a range of blocks from a coin node to .xdmp files.
 *
 * File format (v1):
 *   Header (64 bytes):
 *     0..8    magic "XCHNDMP1"
 *     8       chain code (1=bitcoin, 2=litecoin, 3=dogecoin)
 *     9       network code (1=mainnet, 2=testnet, 3=regtest)
 *     10..12  version (u16 LE)
 *     12..16  first_block_height (u32 LE)
 *     16..20  last_block_height (u32 LE)
 *     20..24  block_count (u32 LE) = last - first + 1
 *     24..28  chain_tip_at_dump (u32 LE) - tip when dump started
 *     28..64  reserved (zero-filled)
 *
 *   Block records (stream after header, ascending height, no gaps):
 *     0..4    block_size (u32 LE)
 *     4..8    block_height (u32 LE)
 *     8..40   block_hash (32 bytes, as returned by getblockhash hex-decoded)
 *     40..40+block_size   raw block bytes (native block serialization)
 *
 ********************************************************************/

const dotenv = require('dotenv')
dotenv.config()

const fs   = require('fs')
const path = require('path')
const BlockchainConnector = require('../BlockchainConnector.js')
const { XdmpReader } = require('./xdmp-reader.js')
const coins = require('../coins')
const { resolveUndoBlocks } = require('../undo-blocks.js')

const MAGIC               = Buffer.from('XCHNDMP1', 'ascii')
const HEADER_SIZE         = 64
const FILE_VERSION        = 1
const DEFAULT_CHUNK_SIZE  = 10000
const DEFAULT_TIP_SAFETY  = 10
const RPC_BATCH_SIZE      = 25
const MAX_BLOCK_SIZE      = 32 * 1024 * 1024

const CHAIN_CODES   = { bitcoin: 1, litecoin: 2, dogecoin: 3 }
const NETWORK_CODES = { mainnet: 1, testnet: 2, regtest: 3 }

function parseArgs(argv) {
    const args = { chunkSize: DEFAULT_CHUNK_SIZE, tipSafety: DEFAULT_TIP_SAFETY }
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i]
        switch (arg) {
            case '--network':    args.network = argv[++i]; break
            case '--from':       args.from = parseInt(argv[++i], 10); break
            case '--to':         args.to = parseInt(argv[++i], 10); args.toExplicit = true; break
            case '--chunk-size': args.chunkSize = parseInt(argv[++i], 10); break
            case '--tip-safety': args.tipSafety = parseInt(argv[++i], 10); args.tipSafetyExplicit = true; break
            case '--allow-undo-window': args.allowUndoWindow = true; break
            case '--out':        args.out = argv[++i]; break
            case '--help':
            case '-h':
                printHelp()
                process.exit(0)
            default:
                throw new Error('Unknown argument: ' + arg)
        }
    }
    return args
}

function printHelp() {
    console.log(`Usage: node src/bulk-sync/dump.js [options]

Options:
  --network <name>      e.g. bitcoin-regtest, bitcoin-mainnet, litecoin-mainnet
  --from <height>       First block height (inclusive, default 0)
  --to <height>         Last block height (inclusive). Excludes --tip-safety.
  --tip-safety <n>      Stop n blocks before tip (default ${DEFAULT_TIP_SAFETY})
  --allow-undo-window   Permit an explicit --to inside the live undo window
                        (unsafe: no K/M reorg-recovery indices are seeded there)
  --chunk-size <n>      Blocks per .xdmp file (default ${DEFAULT_CHUNK_SIZE})
  --out <dir>           Output directory (required)

Examples:
  node src/bulk-sync/dump.js --network bitcoin-regtest --from 0 --to 3400 --out /tmp/dumps/
  node src/bulk-sync/dump.js --network bitcoin-mainnet --from 0 --out /data/dumps/
`)
}

function validateArgs(args) {
    if (!args.network) throw new Error('--network is required')
    if (!args.out)     throw new Error('--out is required')
    if (args.from == null) args.from = 0
    if (args.from < 0 || !Number.isFinite(args.from)) {
        throw new Error('--from must be a non-negative integer')
    }
    if (args.toExplicit && args.tipSafetyExplicit) {
        throw new Error('--to and --tip-safety are mutually exclusive')
    }
    if (args.toExplicit && (!Number.isFinite(args.to) || args.to < args.from)) {
        throw new Error('--to must be a finite integer >= --from')
    }
    if (!Number.isFinite(args.chunkSize) || args.chunkSize <= 0) {
        throw new Error('--chunk-size must be a positive integer')
    }
    if (!Number.isFinite(args.tipSafety) || args.tipSafety < 0) {
        throw new Error('--tip-safety must be a non-negative integer')
    }

    const parts = args.network.split('-')
    if (parts.length !== 2) {
        throw new Error('--network must be <chain>-<network>, e.g. bitcoin-regtest')
    }
    args.chain   = parts[0]
    args.netName = parts[1]
    if (!(args.chain in CHAIN_CODES))    throw new Error('Unknown chain: ' + args.chain)
    if (!(args.netName in NETWORK_CODES)) throw new Error('Unknown network: ' + args.netName)
}

function makeHeader(chain, netName, firstHeight, lastHeight, chainTipAtDump) {
    const buf = Buffer.alloc(HEADER_SIZE)
    MAGIC.copy(buf, 0)
    buf.writeUInt8(CHAIN_CODES[chain],    8)
    buf.writeUInt8(NETWORK_CODES[netName], 9)
    buf.writeUInt16LE(FILE_VERSION,       10)
    buf.writeUInt32LE(firstHeight,        12)
    buf.writeUInt32LE(lastHeight,         16)
    buf.writeUInt32LE(lastHeight - firstHeight + 1, 20)
    buf.writeUInt32LE(chainTipAtDump,     24)
    // bytes 28..63 = reserved, already zeroed by Buffer.alloc
    return buf
}

function chunkFileName(chain, netName, start, end) {
    const s = String(start).padStart(8, '0')
    const e = String(end).padStart(8, '0')
    return `blocks-${chain}-${netName}-${s}-${e}.xdmp`
}

function fmtDuration(ms) {
    const s   = Math.floor(ms / 1000)
    const h   = Math.floor(s / 3600)
    const m   = Math.floor((s % 3600) / 60)
    const sec = s % 60
    return `${h}h${String(m).padStart(2, '0')}m${String(sec).padStart(2, '0')}s`
}

/**
 * True when an existing chunk file covers exactly [chunkStart, chunkEnd] and
 * its last block's stored hash equals the node's getblockhash(chunkEnd).
 * Any read/parse failure (bad magic, truncation, wrong range) counts as a
 * mismatch so the chunk gets re-dumped. Costs one file read pass + one RPC,
 * and only runs for reused chunks.
 */
async function existingChunkMatchesChain(connector, filePath, chunkStart, chunkEnd) {
    let reader
    try {
        reader = new XdmpReader(filePath)
        if (reader.firstHeight !== chunkStart || reader.lastHeight !== chunkEnd) return false
        let lastHash = null
        for (const { blockHash } of reader.blocks()) lastHash = blockHash
        if (!lastHash) return false
        const nodeHash = await connector.getBlockHash(chunkEnd)
        return lastHash.toString('hex') === nodeHash
    } catch (err) {
        console.log(`[dump] existing chunk ${path.basename(filePath)} unreadable (${err.message}); treating as stale`)
        return false
    } finally {
        if (reader) reader.close()
    }
}

async function dumpChunk(connector, args, chunkStart, chunkEnd, chainTipAtDump) {
    const fileName  = chunkFileName(args.chain, args.netName, chunkStart, chunkEnd)
    const finalPath = path.join(args.out, fileName)
    const tmpPath   = finalPath + '.tmp'

    if (fs.existsSync(finalPath)) {
        // Reuse is keyed on the filename (chain/net/range) only, so an
        // existing chunk may be from a pre-reorg run or a different node.
        // Anchor it to the current chain: its last block hash must equal
        // getblockhash(chunkEnd). On mismatch, re-dump instead of silently
        // seeding orphaned-chain blocks.
        if (await existingChunkMatchesChain(connector, finalPath, chunkStart, chunkEnd)) {
            console.log(`[skip] ${fileName} already exists (last hash matches node)`)
            return { skipped: true, bytes: 0, blocks: 0 }
        }
        console.log(`[redo] ${fileName} exists but does not match the node's chain (reorg or wrong node?); re-dumping`)
        fs.unlinkSync(finalPath)
    }
    if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath)
    }

    const startedAt = Date.now()
    const fd = fs.openSync(tmpPath, 'w')
    let bytesWritten = 0

    try {
        const header = makeHeader(args.chain, args.netName, chunkStart, chunkEnd, chainTipAtDump)
        fs.writeSync(fd, header, 0, HEADER_SIZE)
        bytesWritten += HEADER_SIZE

        let cursor = chunkStart
        while (cursor <= chunkEnd) {
            const batchEnd = Math.min(cursor + RPC_BATCH_SIZE - 1, chunkEnd)
            const heights  = []
            for (let h = cursor; h <= batchEnd; h++) heights.push(h)

            // Merge-mined ('auxpow') chains carry an AuxPoW section between the
            // 80-byte header and the tx count; strip it via the without-AuxPoW
            // fetch. Keyed on the coin's declared wireFormat in the canonical coin
            // registry (src/coins), matching the live worker and decoder, not a
            // coin-name literal. args.chain is validated in CHAIN_CODES above.
            const auxPow = coins.WIRE_FORMAT[coins.FULL_NAME_TO_TICK[args.chain]] === 'auxpow'
            const blocks = auxPow
                ? await connector.getBlocksBatchWithoutAuxPow(heights)
                : await connector.getBlocksBatch(heights)

            for (const { height, hash, hex } of blocks) {
                const blockBytes = Buffer.from(hex, 'hex')
                if (blockBytes.length === 0 || blockBytes.length > MAX_BLOCK_SIZE) {
                    throw new Error(`block ${height} has invalid size ${blockBytes.length}`)
                }
                const hashBytes = Buffer.from(hash, 'hex')
                if (hashBytes.length !== 32) {
                    throw new Error(`block ${height} has invalid hash length ${hashBytes.length}`)
                }

                const record = Buffer.alloc(40)
                record.writeUInt32LE(blockBytes.length, 0)
                record.writeUInt32LE(height, 4)
                hashBytes.copy(record, 8)

                fs.writeSync(fd, record, 0, 40)
                fs.writeSync(fd, blockBytes, 0, blockBytes.length)
                bytesWritten += 40 + blockBytes.length
            }

            cursor = batchEnd + 1
        }
        // Durability before the tmp->final rename (see writers.js): a power
        // loss must not persist the rename without the data.
        fs.fsyncSync(fd)
    } finally {
        fs.closeSync(fd)
    }

    fs.renameSync(tmpPath, finalPath)

    const elapsed = Date.now() - startedAt
    const blocks  = chunkEnd - chunkStart + 1
    const mb      = (bytesWritten / (1024 * 1024)).toFixed(1)
    console.log(`[done] ${fileName}: ${blocks} blocks, ${mb} MB, ${fmtDuration(elapsed)}`)
    return { skipped: false, bytes: bytesWritten, blocks }
}

// Reorg-recovery invariant (#4634), enforced here because this is the only place the
// REAL tip is known: bulk-sync emits no K/M reverse indices, so a block it seeds inside
// the live undo window is un-recoverable on reorg (phantom or missing UTXOs until a full
// re-index). The orchestrator's effectiveTipSafety deliberately passes an explicit --to
// through unclamped and its pre-connect log line cannot check that endpoint against a tip
// it has not resolved, so an unsafe --to used to reach the dump on a warning alone
// (). Fail loud instead. --allow-undo-window is the named, auditable opt-in for
// a deliberate partial or backfill seed, and it still warns so the risky choice is logged.
function assertExplicitToOutsideUndoWindow(dumpEnd, chainTipAtDump, network, allowUndoWindow) {
    const undoBlocks = resolveUndoBlocks(network)
    const safeEnd = chainTipAtDump - undoBlocks
    if (dumpEnd <= safeEnd) return safeEnd
    if (!allowUndoWindow) {
        throw new Error(
            `--to ${dumpEnd} lands inside the live undo window (tip ${chainTipAtDump} - ` +
            `undo-blocks ${undoBlocks} = ${safeEnd}); bulk-sync seeds no K/M reorg-recovery ` +
            `indices there, so a reorg into that range leaves phantom or missing UTXOs until ` +
            `a full re-index (#4634). Lower --to to ${safeEnd} or pass --allow-undo-window ` +
            `to override.`
        )
    }
    console.error(
        `[bulk-sync/dump] WARNING: --allow-undo-window set: seeding up to ${dumpEnd} inside the ` +
        `live undo window (safe end ${safeEnd}); a reorg into that range is unrecoverable (#4634)`
    )
    return safeEnd
}

async function main() {
    const args = parseArgs(process.argv)
    validateArgs(args)

    const nodeUrl      = process.env.NODE_URL
    const nodePort     = process.env.NODE_PORT
    const nodeUser     = process.env.NODE_USER
    const nodePassword = process.env.NODE_PASSWORD
    if (!nodeUrl || !nodePort || !nodeUser || !nodePassword) {
        throw new Error('NODE_URL, NODE_PORT, NODE_USER, NODE_PASSWORD must be set in env')
    }

    if (!fs.existsSync(args.out)) {
        fs.mkdirSync(args.out, { recursive: true })
    }

    const connector = new BlockchainConnector(nodeUrl, nodePort, nodeUser, nodePassword)

    const info = await connector.getBlockchainInfo()
    const chainTipAtDump = info.blocks

    let dumpEnd
    if (args.toExplicit) {
        dumpEnd = args.to
        if (dumpEnd > chainTipAtDump) {
            throw new Error(`--to ${dumpEnd} is beyond current tip ${chainTipAtDump}`)
        }
        assertExplicitToOutsideUndoWindow(dumpEnd, chainTipAtDump, args.network, args.allowUndoWindow)
    } else {
        dumpEnd = chainTipAtDump - args.tipSafety
        if (dumpEnd < args.from) {
            throw new Error(
                `computed dump end (tip=${chainTipAtDump} - safety=${args.tipSafety}) is before --from=${args.from}`
            )
        }
    }

    const totalBlocks = dumpEnd - args.from + 1
    console.log(`[bulk-sync/dump] ${args.network}: blocks ${args.from}..${dumpEnd} (${totalBlocks} total, tip=${chainTipAtDump})`)
    console.log(`[bulk-sync/dump] chunk-size=${args.chunkSize}, rpc-batch-size=${RPC_BATCH_SIZE}, out=${args.out}`)

    const startedAt         = Date.now()
    let   totalBytes        = 0
    let   totalBlocksWritten = 0
    let   chunkCount        = 0
    let   chunkStart        = args.from
    while (chunkStart <= dumpEnd) {
        const chunkEnd = Math.min(chunkStart + args.chunkSize - 1, dumpEnd)
        chunkCount++
        const result = await dumpChunk(connector, args, chunkStart, chunkEnd, chainTipAtDump)
        totalBytes         += result.bytes
        totalBlocksWritten += result.blocks
        chunkStart         = chunkEnd + 1
    }

    const tipAfter = (await connector.getBlockchainInfo()).blocks
    const elapsed  = Date.now() - startedAt
    const totalMb  = (totalBytes / (1024 * 1024)).toFixed(1)

    console.log(`[bulk-sync/dump] done: ${totalBlocksWritten} blocks, ${totalMb} MB, ${chunkCount} chunks, ${fmtDuration(elapsed)}`)
    console.log(`[bulk-sync/dump] tip at start=${chainTipAtDump}, tip now=${tipAfter}`)
    if (tipAfter < chainTipAtDump) {
        console.log(`[bulk-sync/dump] WARNING: tip decreased (possible reorg, verify dump integrity)`)
    }
}

module.exports = { existingChunkMatchesChain, parseArgs, assertExplicitToOutsideUndoWindow }

if (require.main === module) {
    main().catch(err => {
        console.error('[bulk-sync/dump] FATAL:', err.message)
        if (err.stack) console.error(err.stack)
        process.exit(1)
    })
}
