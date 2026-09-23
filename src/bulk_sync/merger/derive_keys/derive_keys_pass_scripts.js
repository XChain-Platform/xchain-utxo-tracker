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
 * XChain UTXO Tracker - Bulk Sync Derive-Keys Script Keys
 *
 ********************************************************************/

const fs   = require('fs')
const path = require('path')

const { RecordReader,
        RecordWriter }          = require('../streaming_join.js')
const {
    P_SCRIPT_BLK, P_OUT_BLK, P_BLK_SCRIPT, OUTPUTS_HEADER_SIZE,
    LAYOUT, FlatWriter, sortByKey,
} = require('./record_layout.js')

// Script-candidate record width and its sort-key width (scriptHash + rowIdBE);
// the record layout is spelled out in writeScriptCandidates.
const CAND_REC_SIZE = 72
const CAND_KEY_SIZE = 36

// Phase 5 plus the candidate and W sorts. Returns the sorted candidate path and
// the lowest block height inside the W/Z window.
async function writeScriptCandidates(ctx, stats, lastHeight) {
    const { outputsPath, outDir, tmpDir, ramBudgetBytes, undoBlocks, onProgress, outputsRecordSize } = ctx

    // Phase 5: outputs (pre-cancellation) → script candidates
    // Emit one record per output: scriptHash(32) | rowIdBE(4) | blockHash(32)
    //                             | heightBE(4)  = 72B. Phase 6 reads only
    // scriptHash/blockHash/heightBE to build the S and Z records (neither S nor Z
    // carries a txid, matching the live insertOutputScriptBlock/encodeScriptBlk
    // path), so no per-output txHash is seeded here.
    // Sort by scriptHash+rowIdBE (36B) → for each scriptHash, the record with
    // the smallest rowId (earliest file position = earliest block/tx/vout) is
    // the first occurrence. rowId is a running counter over ALL outputs in the
    // range; BTC mainnet is already past 3B created outputs, so the u32 field
    // bound is enforced below (a silent wrap would corrupt S/Z first-seen order).
    // The same pre-cancellation pass also emits the W creation-block reverse
    // index (one record per created output, keyed by the block it was created
    // in). This mirrors the live path, which calls insertOutputBlock for every
    // output at creation time regardless of whether it is later spent, and is
    // the only index the reorg unwind uses to purge outputs created in a
    // rolled-back seeded block. Emitting it here (rather than off the live-utxos
    // stream) is what keeps spent-within-range outputs covered.
    const candRawPath   = path.join(tmpDir, 'script-cand-raw.dat')
    const wRawPath      = path.join(tmpDir, 'W-raw.dat')
    // W is windowed like the live index: the reorg unwind can never reach past
    // the undoBlocks window, and the live tracker prunes W as blocks age out of
    // it (removeCreatedOutputsBlockIndexOnly). Seeded blocks below the
    // window never re-enter that aging path, so an unwindowed seed would leave
    // one permanent 77B record per output ever created (~hundreds of GB on a
    // from-genesis BTC run). Only outputs created in the last undoBlocks seeded
    // blocks get a W record - byte parity with a live tracker at the same tip.
    const wMinHeight = Math.max(0, lastHeight - undoBlocks + 1)
    const outputsReader = new RecordReader(outputsPath, OUTPUTS_HEADER_SIZE, outputsRecordSize)
    const candRaw       = new FlatWriter(candRawPath, CAND_REC_SIZE)
    const wRaw          = new FlatWriter(wRawPath, LAYOUT.W.recordSize)
    writeCandidateAndWRecords(outputsReader, candRaw, wRaw, wMinHeight)
    stats.outputsSeen = candRaw.count
    stats.W           = wRaw.count
    onProgress({ phase: 'script-cand-raw-done', outputs: stats.outputsSeen })

    const candSortedPath = path.join(tmpDir, 'script-cand-sorted.dat')
    await sortByKey(candRawPath, candSortedPath, CAND_REC_SIZE, CAND_KEY_SIZE, path.join(tmpDir, 'sort-cand'), ramBudgetBytes)
    try { fs.unlinkSync(candRawPath) } catch (_) {}
    onProgress({ phase: 'sort-cand-done' })

    // Sort W by its 45-byte key so the loader streams it in key order (matching
    // every other prefix file) and removeCreatedOutputsInBlock's prefix scan
    // sees a contiguous per-block run.
    await sortByKey(wRawPath, path.join(outDir, 'W.dat'), LAYOUT.W.recordSize, LAYOUT.W.keySize, path.join(tmpDir, 'sort-W'), ramBudgetBytes)
    try { fs.unlinkSync(wRawPath) } catch (_) {}
    onProgress({ phase: 'sort-W-done', W: stats.W })
    return { candSortedPath, wMinHeight }
}

// Writes one script candidate per output, rowId counting in file order, and a W
// record for each output created inside the window, then closes the reader and
// both writers.
function writeCandidateAndWRecords(outputsReader, candRaw, wRaw, wMinHeight) {
    let rowId = 0

    try {
        while (true) {
            const rec = outputsReader.next()
            if (!rec) break
            const txHash8      = rec.subarray(0, 8)
            const voutBE       = rec.subarray(8, 12)
            const heightBE     = rec.subarray(20, 24)
            const scriptPubKey = rec.subarray(56, 88)
            const blockHash    = rec.subarray(88, 120)
            const rid          = rowId++
            if (rid > 0xFFFFFFFF) {
                throw new Error('deriveKeys: output rowId exceeds u32 (' + rid + '); widen the script-candidate rowId field before bulk-syncing this range')
            }
            candRaw.write((buf, off) => {
                scriptPubKey.copy(buf, off + 0, 0, 32)
                buf.writeUInt32BE(rid, off + 32)
                blockHash   .copy(buf, off + 36, 0, 32)
                heightBE    .copy(buf, off + 68, 0, 4)
            })

            // W record: 'W' + blockHash(32) + txHash8(8) + voutBE(4) | script32.
            // Byte-identical to LevelUpDb.kOutBlk / insertOutputBlock. Skipped
            // below the undo window (see wMinHeight above).
            if (heightBE.readUInt32BE(0) < wMinHeight) continue
            wRaw.write((buf, off) => {
                buf[off] = P_OUT_BLK
                blockHash   .copy(buf, off + 1,  0, 32)
                txHash8     .copy(buf, off + 33, 0, 8)
                voutBE      .copy(buf, off + 41, 0, 4)
                scriptPubKey.copy(buf, off + 45, 0, 32)
            })
        }
    } finally {
        outputsReader.close()
        candRaw.close()
        wRaw.close()
    }
}

// Phases 6 and 7: the sorted candidates become S.dat (the first sighting of each
// script) and Z.dat (windowed, sorted by key).
async function deriveScriptKeys(ctx, stats, candSortedPath, wMinHeight) {
    const { outDir, tmpDir, ramBudgetBytes, onProgress } = ctx

    // Phase 6: dedup by scriptHash → S.dat (sorted), Z-raw (unsorted)
    // Because we sorted by (scriptHash, rowId), the first record per
    // scriptHash in the sorted stream is the earliest occurrence. S.dat is
    // already sorted by scriptHash (=key minus prefix): emit in-order.
    const candReader = new RecordReader(candSortedPath, 0, CAND_REC_SIZE)
    const sOut       = new RecordWriter(path.join(outDir, 'S.dat'), LAYOUT.S.recordSize)
    const zRawPath   = path.join(tmpDir, 'Z-raw.dat')
    const zRaw       = new FlatWriter(zRawPath, LAYOUT.Z.recordSize)
    const uniqueScripts = writeFirstSeenScriptRecords(candReader, sOut, zRaw, wMinHeight)
    try { fs.unlinkSync(candSortedPath) } catch (_) {}

    stats.S = uniqueScripts
    stats.Z = zRaw.count // may be < S: Z is windowed to undoBlocks, S is not
    onProgress({ phase: 'SZ-dedup-done', uniqueScripts })

    // Phase 7: sort Z by key
    await sortByKey(zRawPath, path.join(outDir, 'Z.dat'), LAYOUT.Z.recordSize, LAYOUT.Z.keySize, path.join(tmpDir, 'sort-Z'), ramBudgetBytes)
    try { fs.unlinkSync(zRawPath) } catch (_) {}
    onProgress({ phase: 'sort-Z-done' })
}

// Writes the S record, and inside the window the Z record, for the first
// candidate of each script, then closes the reader and both writers. Returns the
// unique script count.
function writeFirstSeenScriptRecords(candReader, sOut, zRaw, wMinHeight) {
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

            // Z record: 'Z' + blockHash(32) + scriptHash(32) | (empty).
            // Windowed like W: only first-seen blocks inside the undoBlocks
            // window get a Z record. The reorg unwind is the sole Z reader and
            // is depth-guarded to that window; deeper seeded records would be
            // permanently unreachable dead weight (the live tracker prunes Z on
            // aging via removeOutputScriptsBlockIndexOnly). S above is emitted
            // unconditionally - it backs the live getFirstSeen query.
            if (heightBE.readUInt32BE(0) < wMinHeight) continue
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
    return uniqueScripts
}

module.exports = { writeScriptCandidates, deriveScriptKeys }
