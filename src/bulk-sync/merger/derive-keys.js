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
 * XChain UTXO Tracker - Bulk Sync Derive-Keys
 *
 * Consumes the merger's intermediate streams and emits one fixed-record
 * file per LevelUpDb prefix (B/T/I/O/H/J/N/S/Z) + a small L.json. The
 * loader streams each file and issues db.batch() writes.
 *
 * Record layout per output file: concatenated (key || value) records, no
 * header, fixed size. Files are sorted ascending by key.
 *
 *   B.dat   33+40 =  73B  (key: 'B'+blockHash32;        val: heightBE(4)+tsBE(4)+prevHash32)
 *   T.dat    9+32 =  41B  (key: 'T'+txHash8(8);         val: blockHash32)
 *   I.dat   13+ 8 =  21B  (key: 'I'+prevTxHash8+voutBE; val: spenderTxHash8)
 *   O.dat   45+44 =  89B  (key: 'O'+script32+txHash8+voutBE;
 *                           val: valueBE(8)+heightBE(4)+fullTxHash32)
 *   H.dat   13+32 =  45B  (key: 'H'+txHash8+voutBE;     val: script32)
 *   J.dat   21+ 0 =  21B  (key: 'J'+spenderTxHash8+prevTxHash8+prevVoutBE)
 *   N.dat   33+ 0 =  33B  (key: 'N'+blockHash32)
 *   S.dat   33+68 = 101B  (key: 'S'+script32;           val: blockHash32+heightBE(4)+fullTxHash32)
 *   Z.dat   65+ 0 =  65B  (key: 'Z'+blockHash32+script32)
 *
 *   L.json             { LAST_BLOCK_HEIGHT: "<hex>", LAST_BLOCK_HASH: "<hex>" }
 *
 * S/Z semantics (option A): scripts are derived from the FULL outputs
 * stream (pre-cancellation) so scripts that appeared and were fully
 * spent are still emitted. For each unique scriptHash, the record
 * retained is the one with the lowest rowId in the source file — i.e.
 * the earliest appearance in block/tx/vout order.
 *
 ********************************************************************/

const fs   = require('fs')
const path = require('path')

const { MetaReader }           = require('./meta-reader.js')
const { externalSort }         = require('./external-sort.js')
const { RecordReader,
        RecordWriter }          = require('./streaming-join.js')

const P_BLOCK      = 0x42 // 'B'
const P_TX         = 0x54 // 'T'
const P_INPUT      = 0x49 // 'I'
const P_OUTPUT     = 0x4F // 'O'
const P_OUT_HINT   = 0x48 // 'H'
const P_IN_HINT    = 0x4A // 'J'
const P_STORED_BLK = 0x4E // 'N'
const P_SCRIPT_BLK = 0x53 // 'S'
const P_BLK_SCRIPT = 0x5A // 'Z'

const OUTPUTS_RECORD_SIZE = 120
const SPENDS_RECORD_SIZE  = 20
const OUTPUTS_HEADER_SIZE = 64
const SPENDS_HEADER_SIZE  = 64

// Per-prefix (keySize, valueSize, recordSize).
const LAYOUT = {
    B: { keySize: 33, valSize: 40, recordSize:  73 },
    T: { keySize:  9, valSize: 32, recordSize:  41 },
    I: { keySize: 13, valSize:  8, recordSize:  21 },
    O: { keySize: 45, valSize: 44, recordSize:  89 },
    H: { keySize: 13, valSize: 32, recordSize:  45 },
    J: { keySize: 21, valSize:  0, recordSize:  21 },
    N: { keySize: 33, valSize:  0, recordSize:  33 },
    S: { keySize: 33, valSize:  4, recordSize:  37 },
    Z: { keySize: 65, valSize:  0, recordSize:  65 },
}

function noop() {}

function ensureDir(p) {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true })
}

// Fixed-record writer with no header, for (key||value) prefix files and
// intermediate unsorted streams.
class FlatWriter {
    constructor(filePath, recordSize) {
        this._fd         = fs.openSync(filePath, 'w')
        this._recordSize = recordSize
        const cap = Math.max(1, Math.floor((256 * 1024) / recordSize))
        this._buf    = Buffer.alloc(cap * recordSize)
        this._len    = 0
        this._count  = 0
        this._closed = false
    }
    write(slotFiller) {
        const off = this._len * this._recordSize
        slotFiller(this._buf, off)
        this._len++
        this._count++
        if (this._len * this._recordSize + this._recordSize > this._buf.length) this._flush()
    }
    _flush() {
        if (this._len === 0) return
        fs.writeSync(this._fd, this._buf, 0, this._len * this._recordSize)
        this._len = 0
    }
    get count() { return this._count }
    close() {
        if (this._closed) return
        this._closed = true
        this._flush()
        try { fs.closeSync(this._fd) } catch (_) {}
    }
}

async function sortByKey(inputPath, outputPath, recordSize, keySize, tmpDir, ramBudgetBytes) {
    return externalSort({
        inputPath, outputPath,
        recordSize, keySize,
        ramBudgetBytes,
        tmpDir,
    })
}

/**
 * @param {Object}  opts
 * @param {string}  opts.metaPath          meta-*.dat
 * @param {string}  opts.outputsPath       outputs-*.dat (pre-cancellation)
 * @param {string}  opts.liveUtxosPath     live-utxos.dat
 * @param {string}  opts.spendsByPrevPath  spends-by-prevtx.dat (sorted)
 * @param {string}  opts.outDir            where to write final per-prefix files
 * @param {string}  opts.tmpDir            temp scratch
 * @param {number}  opts.ramBudgetBytes    sort RAM cap (default 1 GiB)
 * @param {number}  opts.undoBlocks        size of N-prefix window (default 10)
 * @param {boolean} opts.removeSpent       skip T/I/J emission. Matches
 *                                          XChainUtxoTracker.REMOVE_SPENT — when
 *                                          true, live code never writes I/J
 *                                          records so bulk-sync shouldn't either.
 *                                          Default false (emit I/J).
 * @param {Function} opts.onProgress       callback({phase, ...})
 */
async function deriveKeys(opts) {
    const {
        metaPath, outputsPath, liveUtxosPath, spendsByPrevPath,
        outDir, tmpDir,
    } = opts
    const ramBudgetBytes = opts.ramBudgetBytes || (1024 * 1024 * 1024)
    const undoBlocks     = opts.undoBlocks     || 10
    const removeSpent    = Boolean(opts.removeSpent)
    const onProgress     = opts.onProgress     || noop

    if (!metaPath || !outputsPath || !liveUtxosPath || !spendsByPrevPath) {
        throw new Error('deriveKeys: metaPath, outputsPath, liveUtxosPath, spendsByPrevPath are required')
    }
    if (!outDir || !tmpDir) {
        throw new Error('deriveKeys: outDir and tmpDir are required')
    }
    ensureDir(outDir)
    ensureDir(tmpDir)

    const stats = {}

    // ─── Phase 1: meta → B-raw, T-raw, N-raw, capture last block ─────────────
    onProgress({ phase: 'meta-start' })
    const meta = new MetaReader(metaPath)

    const bRawPath = path.join(tmpDir, 'B-raw.dat')
    const tRawPath = path.join(tmpDir, 'T-raw.dat')
    const nRawPath = path.join(tmpDir, 'N-raw.dat')

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

    // ─── Phase 2: sort B, T, N by key ────────────────────────────────────────
    await sortByKey(bRawPath, path.join(outDir, 'B.dat'), LAYOUT.B.recordSize, LAYOUT.B.keySize, path.join(tmpDir, 'sort-B'), ramBudgetBytes)
    if (tRaw) {
        await sortByKey(tRawPath, path.join(outDir, 'T.dat'), LAYOUT.T.recordSize, LAYOUT.T.keySize, path.join(tmpDir, 'sort-T'), ramBudgetBytes)
    }
    await sortByKey(nRawPath, path.join(outDir, 'N.dat'), LAYOUT.N.recordSize, LAYOUT.N.keySize, path.join(tmpDir, 'sort-N'), ramBudgetBytes)
    try { fs.unlinkSync(bRawPath) } catch (_) {}
    try { fs.unlinkSync(tRawPath) } catch (_) {}
    try { fs.unlinkSync(nRawPath) } catch (_) {}
    onProgress({ phase: 'sort-BTN-done' })

    // ─── Phase 3: live-utxos → H.dat (sorted), O-raw (unsorted) ──────────────
    // live-utxos.dat has no header (produced by streaming-join). Records are
    // 120B outputs, sorted by (txHash8, vout). That happens to be H's sort
    // order already → emit H directly with no re-sort.
    const liveReader = new RecordReader(liveUtxosPath, 0, OUTPUTS_RECORD_SIZE)
    const hOut       = new RecordWriter(path.join(outDir, 'H.dat'), LAYOUT.H.recordSize)
    const oRawPath   = path.join(tmpDir, 'O-raw.dat')
    const oRaw       = new FlatWriter(oRawPath, LAYOUT.O.recordSize)
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

            // H record: 'H' + txHash8(8) + voutBE(4) | scriptPubKey(32)
            const hBuf = Buffer.allocUnsafe(LAYOUT.H.recordSize)
            hBuf[0] = P_OUT_HINT
            txHash8.copy(hBuf, 1, 0, 8)
            voutBE.copy(hBuf, 9, 0, 4)
            scriptPubKey.copy(hBuf, 13, 0, 32)
            hOut.writeRecord(hBuf)

            // O record: 'O' + scriptPubKey(32) + txHash8(8) + voutBE(4)
            //          | value(8) + height(4) + fullTxHash(32)
            oRaw.write((buf, off) => {
                buf[off] = P_OUTPUT
                scriptPubKey.copy(buf, off + 1, 0, 32)
                txHash8     .copy(buf, off + 33, 0, 8)
                voutBE      .copy(buf, off + 41, 0, 4)
                valBE       .copy(buf, off + 45, 0, 8)
                heightBE    .copy(buf, off + 53, 0, 4)
                fullTxHash  .copy(buf, off + 57, 0, 32)
            })
        }
    } finally {
        liveReader.close()
        hOut.close()
        oRaw.close()
    }

    stats.H = liveCount
    stats.O = liveCount
    onProgress({ phase: 'live-done', liveCount })

    // ─── Phase 4: sort O by key ──────────────────────────────────────────────
    await sortByKey(oRawPath, path.join(outDir, 'O.dat'), LAYOUT.O.recordSize, LAYOUT.O.keySize, path.join(tmpDir, 'sort-O'), ramBudgetBytes)
    try { fs.unlinkSync(oRawPath) } catch (_) {}
    onProgress({ phase: 'sort-O-done' })

    // ─── Phase 5: outputs (pre-cancellation) → script candidates ─────────────
    // Emit one record per output: scriptHash(32) | rowIdBE(4) | blockHash(32)
    //                             | heightBE(4) | fullTxHash(32)  = 104B.
    // Sort by scriptHash+rowIdBE (36B) → for each scriptHash, the record with
    // the smallest rowId (earliest file position = earliest block/tx/vout) is
    // the first occurrence. rowId is just a running counter; 32 bits covers
    // ~4B outputs, enough for Bitcoin mainnet many times over.
    const CAND_REC_SIZE = 104
    const CAND_KEY_SIZE = 36
    const candRawPath   = path.join(tmpDir, 'script-cand-raw.dat')
    const outputsReader = new RecordReader(outputsPath, OUTPUTS_HEADER_SIZE, OUTPUTS_RECORD_SIZE)
    const candRaw       = new FlatWriter(candRawPath, CAND_REC_SIZE)
    let rowId = 0

    try {
        while (true) {
            const rec = outputsReader.next()
            if (!rec) break
            const heightBE     = rec.subarray(20, 24)
            const fullTxHash   = rec.subarray(24, 56)
            const scriptPubKey = rec.subarray(56, 88)
            const blockHash    = rec.subarray(88, 120)
            const rid          = rowId++
            candRaw.write((buf, off) => {
                scriptPubKey.copy(buf, off + 0, 0, 32)
                buf.writeUInt32BE(rid >>> 0, off + 32)
                blockHash   .copy(buf, off + 36, 0, 32)
                heightBE    .copy(buf, off + 68, 0, 4)
                fullTxHash  .copy(buf, off + 72, 0, 32)
            })
        }
    } finally {
        outputsReader.close()
        candRaw.close()
    }
    stats.outputsSeen = candRaw.count
    onProgress({ phase: 'script-cand-raw-done', outputs: stats.outputsSeen })

    const candSortedPath = path.join(tmpDir, 'script-cand-sorted.dat')
    await sortByKey(candRawPath, candSortedPath, CAND_REC_SIZE, CAND_KEY_SIZE, path.join(tmpDir, 'sort-cand'), ramBudgetBytes)
    try { fs.unlinkSync(candRawPath) } catch (_) {}
    onProgress({ phase: 'sort-cand-done' })

    // ─── Phase 6: dedup by scriptHash → S.dat (sorted), Z-raw (unsorted) ─────
    // Because we sorted by (scriptHash, rowId), the first record per
    // scriptHash in the sorted stream is the earliest occurrence. S.dat is
    // already sorted by scriptHash (=key minus prefix) — emit in-order.
    const candReader = new RecordReader(candSortedPath, 0, CAND_REC_SIZE)
    const sOut       = new RecordWriter(path.join(outDir, 'S.dat'), LAYOUT.S.recordSize)
    const zRawPath   = path.join(tmpDir, 'Z-raw.dat')
    const zRaw       = new FlatWriter(zRawPath, LAYOUT.Z.recordSize)

    let lastScript = null
    let uniqueScripts = 0
    try {
        while (true) {
            const rec = candReader.next()
            if (!rec) break
            const scriptHash = rec.subarray(0, 32)
            if (lastScript && scriptHash.compare(lastScript) === 0) continue // not first
            lastScript = Buffer.from(scriptHash)
            uniqueScripts++

            const blockHash = rec.subarray(36, 68)
            const heightBE  = rec.subarray(68, 72)

            // S record: 'S' + scriptHash(32) | heightBE(4) = 37 bytes
            const sBuf = Buffer.alloc(LAYOUT.S.recordSize)
            sBuf[0] = P_SCRIPT_BLK
            scriptHash.copy(sBuf, 1, 0, 32)
            heightBE  .copy(sBuf, 33, 0, 4)
            sOut.writeRecord(sBuf)

            // Z record: 'Z' + blockHash(32) + scriptHash(32) | (empty)
            zRaw.write((buf, off) => {
                buf[off] = P_BLK_SCRIPT
                blockHash .copy(buf, off + 1, 0, 32)
                scriptHash.copy(buf, off + 33, 0, 32)
            })
        }
    } finally {
        candReader.close()
        sOut.close()
        zRaw.close()
    }
    try { fs.unlinkSync(candSortedPath) } catch (_) {}

    stats.S = uniqueScripts
    stats.Z = uniqueScripts
    onProgress({ phase: 'SZ-dedup-done', uniqueScripts })

    // ─── Phase 7: sort Z by key ──────────────────────────────────────────────
    await sortByKey(zRawPath, path.join(outDir, 'Z.dat'), LAYOUT.Z.recordSize, LAYOUT.Z.keySize, path.join(tmpDir, 'sort-Z'), ramBudgetBytes)
    try { fs.unlinkSync(zRawPath) } catch (_) {}
    onProgress({ phase: 'sort-Z-done' })

    // ─── Phase 8: spends-by-prevtx → I.dat (sorted), J-raw (unsorted) ────────
    // spends-by-prevtx.dat has no header, records = 20B, sorted by
    // (prevTxHash8, prevVout) — matches I key order exactly.
    //
    // Skipped entirely when removeSpent=true: the live tracker with
    // REMOVE_SPENT=true never persists I/J records (spent outputs are
    // deleted immediately after use), so emitting them here would just
    // waste disk + time and produce records nobody reads.
    if (removeSpent) {
        stats.I = 0
        stats.J = 0
        onProgress({ phase: 'spends-skipped-removeSpent' })
    } else {
        const spendsReader = new RecordReader(spendsByPrevPath, 0, SPENDS_RECORD_SIZE)
        const iOut         = new RecordWriter(path.join(outDir, 'I.dat'), LAYOUT.I.recordSize)
        const jRawPath     = path.join(tmpDir, 'J-raw.dat')
        const jRaw         = new FlatWriter(jRawPath, LAYOUT.J.recordSize)
        let spendCount = 0
        try {
            while (true) {
                const rec = spendsReader.next()
                if (!rec) break
                spendCount++
                const prevTxHash8    = rec.subarray(0, 8)
                const prevVoutBE     = rec.subarray(8, 12)
                const spenderTxHash8 = rec.subarray(12, 20)

                // I record: 'I' + prevTxHash8(8) + prevVoutBE(4) | spenderTxHash8(8)
                const iBuf = Buffer.allocUnsafe(LAYOUT.I.recordSize)
                iBuf[0] = P_INPUT
                prevTxHash8   .copy(iBuf, 1, 0, 8)
                prevVoutBE    .copy(iBuf, 9, 0, 4)
                spenderTxHash8.copy(iBuf, 13, 0, 8)
                iOut.writeRecord(iBuf)

                // J record: 'J' + spenderTxHash8(8) + prevTxHash8(8) + prevVoutBE(4) | (empty)
                jRaw.write((buf, off) => {
                    buf[off] = P_IN_HINT
                    spenderTxHash8.copy(buf, off + 1,  0, 8)
                    prevTxHash8   .copy(buf, off + 9,  0, 8)
                    prevVoutBE    .copy(buf, off + 17, 0, 4)
                })
            }
        } finally {
            spendsReader.close()
            iOut.close()
            jRaw.close()
        }
        stats.I = spendCount
        stats.J = spendCount
        onProgress({ phase: 'spends-done', spendCount })

        // ─── Phase 9: sort J by key ──────────────────────────────────────────────
        await sortByKey(jRawPath, path.join(outDir, 'J.dat'), LAYOUT.J.recordSize, LAYOUT.J.keySize, path.join(tmpDir, 'sort-J'), ramBudgetBytes)
        try { fs.unlinkSync(jRawPath) } catch (_) {}
        onProgress({ phase: 'sort-J-done' })
    }

    // ─── Phase 10: L markers (JSON) ──────────────────────────────────────────
    if (lastBlockHash == null) {
        throw new Error('deriveKeys: meta file had no blocks — cannot emit LAST_* markers')
    }
    const lJson = {
        LAST_BLOCK_HEIGHT: lastHeight.toString(16),
        LAST_BLOCK_HASH:   lastBlockHash.toString('hex'),
    }
    fs.writeFileSync(path.join(outDir, 'L.json'), JSON.stringify(lJson, null, 2))
    stats.L = 2
    stats.lastHeight = lastHeight

    onProgress({ phase: 'done', stats })
    return { stats, layout: LAYOUT }
}

module.exports = { deriveKeys, LAYOUT }
