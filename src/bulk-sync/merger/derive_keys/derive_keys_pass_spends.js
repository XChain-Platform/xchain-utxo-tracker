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
 * XChain UTXO Tracker - Bulk Sync Derive-Keys Spend Keys
 *
 ********************************************************************/

const fs   = require('fs')
const path = require('path')

const { RecordReader,
        RecordWriter }          = require('../streaming_join.js')
const {
    P_INPUT, P_IN_HINT, SPENDS_RECORD_SIZE,
    LAYOUT, FlatWriter, sortByKey,
} = require('./record_layout.js')

// Phases 8 and 9: spends-by-prevtx becomes I.dat (already in key order) and
// J.dat (sorted by key), or nothing at all when removeSpent is set.
async function deriveSpendKeys(ctx, stats) {
    const { spendsByPrevPath, outDir, tmpDir, ramBudgetBytes, removeSpent, onProgress } = ctx

    // Phase 8: spends-by-prevtx → I.dat (sorted), J-raw (unsorted)
    // spends-by-prevtx.dat has no header, records = 20B, sorted by
    // (prevTxHash8, prevVout): matches I key order exactly.
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
        const spendCount   = writeSpendRecords(spendsReader, iOut, jRaw)
        stats.I = spendCount
        stats.J = spendCount
        onProgress({ phase: 'spends-done', spendCount })

        // Phase 9: sort J by key
        await sortByKey(jRawPath, path.join(outDir, 'J.dat'), LAYOUT.J.recordSize, LAYOUT.J.keySize, path.join(tmpDir, 'sort-J'), ramBudgetBytes)
        try { fs.unlinkSync(jRawPath) } catch (_) {}
        onProgress({ phase: 'sort-J-done' })
    }
}

// Writes one I record and one J record per spend, then closes the reader and
// both writers. Returns the spend count.
function writeSpendRecords(spendsReader, iOut, jRaw) {
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
    return spendCount
}

module.exports = { deriveSpendKeys }
