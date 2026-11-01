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
    P_TX_EXACT, P_TX_BLOCK_RECOVERY,
    OUTPUTS_RECORD_SIZE, OUTPUTS_HEADER_SIZE,
    OUT_TXID, OUT_VOUT, OUT_VALUE, OUT_HEIGHT, OUT_SCRIPT, OUT_BLOCK, OUT_COINBASE,
    LAYOUT, noop, ensureDir, clearPriorDeriveOutputs, FlatWriter, sortByKey,
} = require('./record_layout.js')
const { writeScriptCandidates,
        deriveScriptKeys }      = require('./derive_keys_pass_scripts.js')
const { deriveSpendKeys }      = require('./derive_keys_pass_spends.js')

// T.dat carries the block height after the key so the sort orders colliding
// txids by block and the loader's later put (the higher block) wins the slot;
// the loader drops those 4 bytes.
const TX_INDEX_LAYOUT = {
    T: { keySize: 33, valSize: 68, recordSize: 101 },
    X: { keySize: 33, valSize: 32, recordSize:  65 },
    Y: { keySize: 65, valSize: 32, recordSize:  97 },
}

/**
 * @param {Object}  opts
 * @param {string}  opts.metaPath          meta-*.dat
 * @param {string}  opts.outputsPath       outputs-*.dat (pre-cancellation)
 * @param {string}  opts.liveUtxosPath     live-utxos.dat
 * @param {string}  opts.spendsByPrevPath  spends-by-prevtx.dat (sorted)
 * @param {string}  opts.outDir            where to write final per-prefix files;
 *                                          any prefix .dat and L.json already
 *                                          there are removed first
 * @param {string}  opts.tmpDir            temp scratch
 * @param {number}  opts.outputsRecordSize width of records in outputsPath /
 *                                          liveUtxosPath, from the dump header's
 *                                          record_size field. Must be the
 *                                          current OUTPUTS_RECORD_SIZE (113, the
 *                                          format-2 record with its trailing
 *                                          coinbase byte); a dump of another
 *                                          width is from an older format and
 *                                          is refused.
 * @param {number}  opts.ramBudgetBytes    sort RAM cap (default 1 GiB)
 * @param {string}  opts.network           network string e.g. 'dogecoin-mainnet'.
 *                                          Resolves per-chain undoBlocks
 *                                          when opts.undoBlocks is not provided.
 * @param {number}  opts.undoBlocks        size of N-prefix window. Should match
 *                                          the live tracker's per-chain undoBlocks
 *                                          so the seeded N-prefix covers the full
 *                                          reorg recovery window. If omitted,
 *                                          resolved from opts.network and the
 *                                          XCHAIN_UNDO_BLOCKS_<COIN> env var.
 * @param {boolean} opts.removeSpent       default true, the live-parity seed:
 *                                          skips I/J (the live confirmed path
 *                                          never writes them) and the legacy
 *                                          32-byte T. Explicit false emits
 *                                          32-byte T plus I/J, which is NOT a
 *                                          parity seed and is kept for fixtures
 *                                          and diagnostics.
 * @param {boolean} opts.txIndex           defaults on for non-Bitcoin networks.
 *                                          When true, T/X/Y are emitted in the
 *                                          live shape (64-byte T, exact-txid X,
 *                                          window-limited Y) from the full txids
 *                                          in the outputs stream, and the legacy
 *                                          32-byte T is not.
 * @param {Function} opts.onProgress       callback({phase, ...})
 */
async function deriveKeys(opts) {
    const ctx = resolveDeriveOptions(opts)
    const { onProgress } = ctx

    const stats = {}

    clearPriorDeriveOutputs(ctx.outDir, [...Object.keys(LAYOUT), ...Object.keys(TX_INDEX_LAYOUT)])
    const { lastHeight, lastBlockHash } = await deriveBlockKeys(ctx, stats)
    await deriveOutputKeys(ctx, stats)
    const wMinHeight = Math.max(0, lastHeight - ctx.undoBlocks + 1)
    if (ctx.txIndex) await deriveTxIndexKeys(ctx, stats, wMinHeight)
    const { candSortedPath } = await writeScriptCandidates(ctx, stats, lastHeight)
    await deriveScriptKeys(ctx, stats, candSortedPath, wMinHeight)
    await deriveSpendKeys(ctx, stats)
    writeLastBlockMarkers(ctx.outDir, stats, lastHeight, lastBlockHash, ctx.txIndex)

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
    const removeSpent    = opts.removeSpent !== false
    const txIndex        = opts.txIndex === undefined
        ? !/^bitcoin(?:-|$)/i.test(String(opts.network))
        : opts.txIndex === true
    const onProgress     = opts.onProgress     || noop
    // A format-1 record (120 or 121 bytes, 8-byte txid key) would misframe every
    // field below, so only the current width is accepted.
    const outputsRecordSize = opts.outputsRecordSize || OUTPUTS_RECORD_SIZE
    if (outputsRecordSize !== OUTPUTS_RECORD_SIZE) {
        throw new Error(`deriveKeys: unsupported outputsRecordSize ${outputsRecordSize} (expected ${OUTPUTS_RECORD_SIZE});`
            + ' outputs from an older bulk-sync format must be parsed again')
    }

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
        ramBudgetBytes, undoBlocks, removeSpent, txIndex, onProgress,
        outputsRecordSize,
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
    const { removeSpent, txIndex, undoBlocks } = ctx

    const bRaw = new FlatWriter(bRawPath, LAYOUT.B.recordSize)
    const tRaw = (removeSpent || txIndex) ? null : new FlatWriter(tRawPath, LAYOUT.T.recordSize)

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

            // Legacy T: val = blockHash (32B); txIndex emits the live 64B T instead
            if (tRaw) {
                for (let i = 0; i < blk.txidList.length; i++) {
                    const txid = blk.txidList[i]
                    tRaw.write((buf, off) => {
                        buf[off] = P_TX
                        txid.copy(buf, off + 1, 0, 32)
                        blk.blockHash.copy(buf, off + 33, 0, 32)
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

// Phase 9: the live-parity tx index. Every transaction has at least one output and
// a tx's outputs are adjacent, so the pre-cancellation outputs stream names each
// full txid with its block; X.dat and the window-limited Y.dat follow from it.
async function deriveTxIndexKeys(ctx, stats, wMinHeight) {
    const { outputsPath, outputsRecordSize, outDir, tmpDir, ramBudgetBytes, onProgress } = ctx
    const raw = {}
    const rawPath = {}
    for (const k of ['T', 'X', 'Y']) {
        rawPath[k] = path.join(tmpDir, k + '-tx-raw.dat')
        raw[k] = new FlatWriter(rawPath[k], TX_INDEX_LAYOUT[k].recordSize)
    }
    const reader = new RecordReader(outputsPath, OUTPUTS_HEADER_SIZE, outputsRecordSize)
    let prev = null
    try {
        for (let rec = reader.next(); rec; rec = reader.next()) {
            const fullTxid = rec.subarray(OUT_TXID, OUT_TXID + 32)
            if (prev !== null && prev.equals(fullTxid)) continue
            prev = Buffer.from(fullTxid)
            const heightBE = rec.subarray(OUT_HEIGHT, OUT_HEIGHT + 4), blockHash = rec.subarray(OUT_BLOCK, OUT_BLOCK + 32)
            raw.T.write((buf, off) => {
                buf[off] = P_TX
                fullTxid.copy(buf, off + 1); heightBE.copy(buf, off + 33)
                blockHash.copy(buf, off + 37); fullTxid.copy(buf, off + 69)
            })
            raw.X.write((buf, off) => {
                buf[off] = P_TX_EXACT
                fullTxid.copy(buf, off + 1); blockHash.copy(buf, off + 33)
            })
            if (heightBE.readUInt32BE(0) < wMinHeight) continue
            raw.Y.write((buf, off) => {
                buf[off] = P_TX_BLOCK_RECOVERY
                blockHash.copy(buf, off + 1); fullTxid.copy(buf, off + 33); fullTxid.copy(buf, off + 65)
            })
        }
    } finally {
        reader.close()
        for (const k of ['T', 'X', 'Y']) raw[k].close()
    }
    // T sorts on key plus height (37B) so a txid two blocks carry ends in block order.
    const sortKey = { T: 37, X: 33, Y: 65 }
    for (const k of ['T', 'X', 'Y']) {
        await sortByKey(rawPath[k], path.join(outDir, k + '.dat'), TX_INDEX_LAYOUT[k].recordSize, sortKey[k], path.join(tmpDir, 'sort-tx-' + k), ramBudgetBytes)
        try { fs.unlinkSync(rawPath[k]) } catch (_) {}
        stats[k] = raw[k].count
    }
    onProgress({ phase: 'tx-index-done', T: stats.T, X: stats.X, Y: stats.Y })
}

// Phases 3 and 4: live-utxos becomes H.dat (already in key order) and O.dat
// (sorted by key).
async function deriveOutputKeys(ctx, stats) {
    const { liveUtxosPath, outDir, tmpDir, ramBudgetBytes, onProgress, outputsRecordSize } = ctx

    // Phase 3: live-utxos → H.dat (sorted), O-raw (unsorted)
    // live-utxos.dat has no header (produced by streaming-join). Records are
    // outputs records sorted by (txid, vout). That happens to be H's sort
    // order already → emit H directly with no re-sort.
    const liveReader = new RecordReader(liveUtxosPath, 0, outputsRecordSize)
    const hOut       = new RecordWriter(path.join(outDir, 'H.dat'), LAYOUT.H.recordSize)
    const oRawPath   = path.join(tmpDir, 'O-raw.dat')
    const oRaw       = new FlatWriter(oRawPath, LAYOUT.O.recordSize)
    const liveCount  = writeLiveOutputRecords(liveReader, hOut, oRaw)

    stats.H = stats.O = liveCount
    onProgress({ phase: 'live-done', liveCount })

    // Phase 4: sort O by key
    await sortByKey(oRawPath, path.join(outDir, 'O.dat'), LAYOUT.O.recordSize, LAYOUT.O.keySize, path.join(tmpDir, 'sort-O'), ramBudgetBytes)
    try { fs.unlinkSync(oRawPath) } catch (_) {}
    onProgress({ phase: 'sort-O-done' })
}

// Writes one H record and one O record per live UTXO, then closes the reader
// and both writers. Returns the live UTXO count.
function writeLiveOutputRecords(liveReader, hOut, oRaw) {
    let liveCount = 0

    try {
        while (true) {
            const rec = liveReader.next()
            if (!rec) break
            liveCount++

            // Layout from writers.js OutputsWriter (format 2):
            //   [0..32]   txid (display order)
            //   [32..36]  vout (BE u32)
            //   [36..44]  value (BE u64)
            //   [44..48]  height (BE i32)
            //   [48..80]  scriptPubKey (sha256 of the script)
            //   [80..112] blockHash
            //   [112]     coinbase flag (1 = coinbase output)
            // Every field is a view into the reader's buffer, copied out below.
            const txid         = rec.subarray(OUT_TXID, OUT_TXID + 32)
            const voutBE       = rec.subarray(OUT_VOUT, OUT_VOUT + 4)
            const valBE        = rec.subarray(OUT_VALUE, OUT_VALUE + 8)
            const heightBE     = rec.subarray(OUT_HEIGHT, OUT_HEIGHT + 4)
            const scriptPubKey = rec.subarray(OUT_SCRIPT, OUT_SCRIPT + 32)
            const coinbase     = rec[OUT_COINBASE] === 1

            // H record: 'H' + txid(32) + voutBE(4) | scriptPubKey(32)
            const hBuf = Buffer.allocUnsafe(LAYOUT.H.recordSize)
            hBuf[0] = P_OUT_HINT
            txid.copy(hBuf, 1, 0, 32)
            voutBE.copy(hBuf, 33, 0, 4)
            scriptPubKey.copy(hBuf, 37, 0, 32)
            hOut.writeRecord(hBuf)

            // O record: 'O' + scriptPubKey(32) + txid(32) + voutBE(4)
            //          | value(8) + height(4) + fullTxHash(32) + coinbase(1)
            // The coinbase byte keeps the record fixed-width for the external
            // sort; the loader collapses it to the live path's optional-byte
            // form so a non-coinbase O-value stays 44 bytes on disk.
            oRaw.write((buf, off) => {
                buf[off] = P_OUTPUT
                scriptPubKey.copy(buf, off + 1, 0, 32)
                txid        .copy(buf, off + 33, 0, 32)
                voutBE      .copy(buf, off + 65, 0, 4)
                valBE       .copy(buf, off + 69, 0, 8)
                heightBE    .copy(buf, off + 77, 0, 4)
                txid        .copy(buf, off + 81, 0, 32)
                buf[off + 113] = coinbase ? 1 : 0
            })
        }
    } finally {
        liveReader.close()
        hOut.close()
        oRaw.close()
    }
    return liveCount
}

// Phase 10: L markers (JSON), plus this run's txIndex decision so the loader
// follows it rather than guessing from the files present.
function writeLastBlockMarkers(outDir, stats, lastHeight, lastBlockHash, txIndex) {
    if (lastBlockHash == null) {
        throw new Error('deriveKeys: meta file had no blocks; cannot emit LAST_* markers')
    }
    const lJson = {
        LAST_BLOCK_HEIGHT: lastHeight.toString(16),
        LAST_BLOCK_HASH:   lastBlockHash.toString('hex'),
        txIndex:           txIndex === true,
    }
    fs.writeFileSync(path.join(outDir, 'L.json'), JSON.stringify(lJson, null, 2))
    stats.L = 2
    stats.lastHeight = lastHeight
}

module.exports = { deriveKeys, TX_INDEX_LAYOUT }
