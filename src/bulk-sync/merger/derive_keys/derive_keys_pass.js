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
 * XChain UTXO Tracker - Bulk Sync Derive-Keys Pass
 *
 ********************************************************************/

const fs   = require('fs')
const path = require('path')

const { MetaReader }           = require('../meta_reader.js')
const { RecordReader,
        RecordWriter }          = require('../streaming_join.js')
// The seeded N, W and Z windows read the undo depth only through this resolver.
const { resolveUndoBlocks }    = require('../../../chain/undo_blocks.js')
const {
    P_BLOCK, P_TX, P_OUTPUT, P_OUT_HINT, P_STORED_BLK,
    OUTPUTS_RECORD_SIZE, OUTPUTS_RECORD_SIZE_CB,
    LAYOUT, noop, ensureDir, FlatWriter, sortByKey,
} = require('./record_layout.js')
const { writeScriptCandidates,
        deriveScriptKeys }      = require('./derive_keys_pass_scripts.js')
const { deriveSpendKeys }      = require('./derive_keys_pass_spends.js')

/**
 * @param {Object}  opts
 * @param {string}  opts.metaPath          meta-*.dat
 * @param {string}  opts.outputsPath       outputs-*.dat (pre-cancellation)
 * @param {string}  opts.liveUtxosPath     live-utxos.dat
 * @param {string}  opts.spendsByPrevPath  spends-by-prevtx.dat (sorted)
 * @param {string}  opts.outDir            where to write final per-prefix files
 * @param {string}  opts.tmpDir            temp scratch
 * @param {number}  opts.outputsRecordSize width of records in outputsPath /
 *                                          liveUtxosPath. 121 for dumps that
 *                                          carry the coinbase flag, 120
 *                                          for legacy dumps. Defaults to 120 so
 *                                          legacy callers keep working. The
 *                                          orchestrator reads it from the dump
 *                                          header's record_size field.
 * @param {number}  opts.ramBudgetBytes    sort RAM cap (default 1 GiB)
 * @param {string}  opts.network           network string e.g. 'dogecoin-mainnet'.
 *                                          Used to resolve per-chain undoBlocks
 *                                          when opts.undoBlocks is not provided.
 * @param {number}  opts.undoBlocks        size of N-prefix window. Should match
 *                                          the live tracker's per-chain undoBlocks
 *                                          so the seeded N-prefix covers the full
 *                                          reorg recovery window. If omitted,
 *                                          resolved from opts.network and the
 *                                          XCHAIN_UNDO_BLOCKS_<COIN> env var.
 * @param {boolean} opts.removeSpent       skip T/I/J emission. Matches
 *                                          XChainUtxoTracker.REMOVE_SPENT; when
 *                                          true, live code never writes I/J
 *                                          records so bulk-sync shouldn't either.
 *                                          Default false (emit I/J).
 * @param {Function} opts.onProgress       callback({phase, ...})
 */
async function deriveKeys(opts) {
    const ctx = resolveDeriveOptions(opts)
    const { onProgress } = ctx

    const stats = {}

    const { lastHeight, lastBlockHash } = await deriveBlockKeys(ctx, stats)
    await deriveOutputKeys(ctx, stats)
    const { candSortedPath, wMinHeight } = await writeScriptCandidates(ctx, stats, lastHeight)
    await deriveScriptKeys(ctx, stats, candSortedPath, wMinHeight)
    await deriveSpendKeys(ctx, stats)
    writeLastBlockMarkers(ctx.outDir, stats, lastHeight, lastBlockHash)

    onProgress({ phase: 'done', stats })
    return { stats, layout: LAYOUT }
}

// Reads every option deriveKeys takes and applies its defaults. The undo window
// resolves (and throws for a chain the registry does not name) before the
// record-width and required-path checks; both directories exist on return.
function resolveDeriveOptions(opts) {
    const {
        metaPath, outputsPath, liveUtxosPath, spendsByPrevPath,
        outDir, tmpDir,
    } = opts
    const ramBudgetBytes = opts.ramBudgetBytes || (1024 * 1024 * 1024)
    const undoBlocks     = resolveUndoBlocks(opts.network, opts.undoBlocks)
    const removeSpent    = Boolean(opts.removeSpent)
    const onProgress     = opts.onProgress     || noop
    const outputsRecordSize = opts.outputsRecordSize || OUTPUTS_RECORD_SIZE
    if (outputsRecordSize !== OUTPUTS_RECORD_SIZE && outputsRecordSize !== OUTPUTS_RECORD_SIZE_CB) {
        throw new Error(`deriveKeys: unsupported outputsRecordSize ${outputsRecordSize} (expected 120 or 121)`)
    }
    // Coinbase flag lives at byte 120, present only in 121-byte records.
    const hasCoinbaseByte = outputsRecordSize === OUTPUTS_RECORD_SIZE_CB

    if (!metaPath || !outputsPath || !liveUtxosPath || !spendsByPrevPath) {
        throw new Error('deriveKeys: metaPath, outputsPath, liveUtxosPath, spendsByPrevPath are required')
    }
    if (!outDir || !tmpDir) {
        throw new Error('deriveKeys: outDir and tmpDir are required')
    }
    ensureDir(outDir)
    ensureDir(tmpDir)

    return {
        metaPath, outputsPath, liveUtxosPath, spendsByPrevPath, outDir, tmpDir,
        ramBudgetBytes, undoBlocks, removeSpent, onProgress,
        outputsRecordSize, hasCoinbaseByte,
    }
}

// Phases 1 and 2: the meta stream becomes B.dat, T.dat and N.dat, each sorted
// by key. Returns the last block's height and hash, which the W/Z window and
// the L markers read.
async function deriveBlockKeys(ctx, stats) {
    const { metaPath, outDir, tmpDir, ramBudgetBytes, onProgress } = ctx

    // Phase 1: meta → B-raw, T-raw, N-raw, capture last block
    onProgress({ phase: 'meta-start' })
    const meta = new MetaReader(metaPath)

    const bRawPath = path.join(tmpDir, 'B-raw.dat')
    const tRawPath = path.join(tmpDir, 'T-raw.dat')
    const nRawPath = path.join(tmpDir, 'N-raw.dat')

    const { bRaw, tRaw, nWindow, lastHeight, lastBlockHash } = scanMetaBlocks(ctx, meta, bRawPath, tRawPath)

    // Write N raw (at most `undoBlocks` entries).
    {
        const nRaw = new FlatWriter(nRawPath, LAYOUT.N.recordSize)
        for (const h of nWindow) {
            nRaw.write((buf, off) => {
                buf[off] = P_STORED_BLK
                h.copy(buf, off + 1, 0, 32)
            })
        }
        nRaw.close()
    }

    stats.blocks = bRaw.count
    stats.T      = tRaw ? tRaw.count : 0
    stats.N      = nWindow.length
    stats.B      = bRaw.count
    onProgress({ phase: 'meta-done', ...stats })

    // Phase 2: sort B, T, N by key
    await sortByKey(bRawPath, path.join(outDir, 'B.dat'), LAYOUT.B.recordSize, LAYOUT.B.keySize, path.join(tmpDir, 'sort-B'), ramBudgetBytes)
    if (tRaw) {
        await sortByKey(tRawPath, path.join(outDir, 'T.dat'), LAYOUT.T.recordSize, LAYOUT.T.keySize, path.join(tmpDir, 'sort-T'), ramBudgetBytes)
    }
    await sortByKey(nRawPath, path.join(outDir, 'N.dat'), LAYOUT.N.recordSize, LAYOUT.N.keySize, path.join(tmpDir, 'sort-N'), ramBudgetBytes)
    try { fs.unlinkSync(bRawPath) } catch (_) {}
    try { fs.unlinkSync(tRawPath) } catch (_) {}
    try { fs.unlinkSync(nRawPath) } catch (_) {}
    onProgress({ phase: 'sort-BTN-done' })
    return { lastHeight, lastBlockHash }
}

// Streams every meta block into B-raw and, unless removeSpent is set, T-raw,
// and keeps the last undoBlocks block hashes for N. Closes the reader and both
// writers.
function scanMetaBlocks(ctx, meta, bRawPath, tRawPath) {
    const { removeSpent, undoBlocks } = ctx

    const bRaw = new FlatWriter(bRawPath, LAYOUT.B.recordSize)
    const tRaw = removeSpent ? null : new FlatWriter(tRawPath, LAYOUT.T.recordSize)

    // Sliding window of the last `undoBlocks` block hashes as Buffers.
    const nWindow = []
    let lastHeight    = -1
    let lastBlockHash = null

    try {
        for (const blk of meta.blocks()) {
            // B: key 'B'+blockHash, val height+ts+prevHash (40B)
            bRaw.write((buf, off) => {
                buf[off] = P_BLOCK
                blk.blockHash.copy(buf, off + 1, 0, 32)
                buf.writeUInt32BE(blk.height,    off + 33)
                buf.writeUInt32BE(blk.timestamp, off + 37)
                blk.previousHash.copy(buf, off + 41, 0, 32)
            })

            // T: one per inlined txHash8 → val = blockHash (32B)
            if (tRaw) {
                for (let i = 0; i < blk.txHash8List.length; i++) {
                    const th = blk.txHash8List[i]
                    tRaw.write((buf, off) => {
                        buf[off] = P_TX
                        th.copy(buf, off + 1, 0, 8)
                        blk.blockHash.copy(buf, off + 9, 0, 32)
                    })
                }
            }

            // N window: keep only the last `undoBlocks` block hashes.
            nWindow.push(Buffer.from(blk.blockHash))
            if (nWindow.length > undoBlocks) nWindow.shift()

            lastHeight    = blk.height
            lastBlockHash = Buffer.from(blk.blockHash)
        }
    } finally {
        meta.close()
        bRaw.close()
        if (tRaw) tRaw.close()
    }
    return { bRaw, tRaw, nWindow, lastHeight, lastBlockHash }
}

// Phases 3 and 4: live-utxos becomes H.dat (already in key order) and O.dat
// (sorted by key).
async function deriveOutputKeys(ctx, stats) {
    const { liveUtxosPath, outDir, tmpDir, ramBudgetBytes, onProgress, outputsRecordSize, hasCoinbaseByte } = ctx

    // Phase 3: live-utxos → H.dat (sorted), O-raw (unsorted)
    // live-utxos.dat has no header (produced by streaming-join). Records are
    // 120B outputs, sorted by (txHash8, vout). That happens to be H's sort
    // order already → emit H directly with no re-sort.
    const liveReader = new RecordReader(liveUtxosPath, 0, outputsRecordSize)
    const hOut       = new RecordWriter(path.join(outDir, 'H.dat'), LAYOUT.H.recordSize)
    const oRawPath   = path.join(tmpDir, 'O-raw.dat')
    const oRaw       = new FlatWriter(oRawPath, LAYOUT.O.recordSize)
    const liveCount  = writeLiveOutputRecords(liveReader, hOut, oRaw, hasCoinbaseByte)

    stats.H = liveCount
    stats.O = liveCount
    onProgress({ phase: 'live-done', liveCount })

    // Phase 4: sort O by key
    await sortByKey(oRawPath, path.join(outDir, 'O.dat'), LAYOUT.O.recordSize, LAYOUT.O.keySize, path.join(tmpDir, 'sort-O'), ramBudgetBytes)
    try { fs.unlinkSync(oRawPath) } catch (_) {}
    onProgress({ phase: 'sort-O-done' })
}

// Writes one H record and one O record per live UTXO, then closes the reader
// and both writers. Returns the live UTXO count.
function writeLiveOutputRecords(liveReader, hOut, oRaw, hasCoinbaseByte) {
    let liveCount = 0

    try {
        while (true) {
            const rec = liveReader.next()
            if (!rec) break
            liveCount++

            // Layout from writers.js OutputsWriter:
            //   [0..8]    txHash8
            //   [8..12]   vout (BE u32)
            //   [12..20]  value (BE u64)
            //   [20..24]  height (BE i32)
            //   [24..56]  fullTxHash
            //   [56..88]  scriptPubKey
            //   [88..120] blockHash
            const txHash8      = rec.subarray(0, 8)
            // voutBE is stored in-place at [8..12]; we'll slice it.
            const voutBE       = rec.subarray(8, 12)
            const valBE        = rec.subarray(12, 20)
            const heightBE     = rec.subarray(20, 24)
            const fullTxHash   = rec.subarray(24, 56)
            const scriptPubKey = rec.subarray(56, 88)
            // Byte 120 exists only in 121-byte records; legacy 120-byte
            // records have no flag and are treated as non-coinbase.
            const coinbase     = hasCoinbaseByte && rec[120] === 1

            // H record: 'H' + txHash8(8) + voutBE(4) | scriptPubKey(32)
            const hBuf = Buffer.allocUnsafe(LAYOUT.H.recordSize)
            hBuf[0] = P_OUT_HINT
            txHash8.copy(hBuf, 1, 0, 8)
            voutBE.copy(hBuf, 9, 0, 4)
            scriptPubKey.copy(hBuf, 13, 0, 32)
            hOut.writeRecord(hBuf)

            // O record: 'O' + scriptPubKey(32) + txHash8(8) + voutBE(4)
            //          | value(8) + height(4) + fullTxHash(32) + coinbase(1)
            // The coinbase byte keeps the record fixed-width for the external
            // sort; the loader collapses it to the live path's optional-byte
            // form so a non-coinbase O-value stays 44 bytes on disk.
            oRaw.write((buf, off) => {
                buf[off] = P_OUTPUT
                scriptPubKey.copy(buf, off + 1, 0, 32)
                txHash8     .copy(buf, off + 33, 0, 8)
                voutBE      .copy(buf, off + 41, 0, 4)
                valBE       .copy(buf, off + 45, 0, 8)
                heightBE    .copy(buf, off + 53, 0, 4)
                fullTxHash  .copy(buf, off + 57, 0, 32)
                buf[off + 89] = coinbase ? 1 : 0
            })
        }
    } finally {
        liveReader.close()
        hOut.close()
        oRaw.close()
    }
    return liveCount
}

// Phase 10: L markers (JSON)
function writeLastBlockMarkers(outDir, stats, lastHeight, lastBlockHash) {
    if (lastBlockHash == null) {
        throw new Error('deriveKeys: meta file had no blocks; cannot emit LAST_* markers')
    }
    const lJson = {
        LAST_BLOCK_HEIGHT: lastHeight.toString(16),
        LAST_BLOCK_HASH:   lastBlockHash.toString('hex'),
    }
    fs.writeFileSync(path.join(outDir, 'L.json'), JSON.stringify(lJson, null, 2))
    stats.L = 2
    stats.lastHeight = lastHeight
}

module.exports = { deriveKeys }
