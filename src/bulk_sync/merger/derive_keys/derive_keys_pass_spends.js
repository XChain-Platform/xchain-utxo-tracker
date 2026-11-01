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
    SPD_PREV_TXID, SPD_PREV_VOUT, SPD_SPENDER_TXID,
    LAYOUT, FlatWriter, sortByKey,
} = require('./record_layout.js')

// Phases 8 and 9: spends-by-prevtx becomes I.dat (already in key order) and
// J.dat (sorted by key), or nothing at all when removeSpent is set.
async function deriveSpendKeys(ctx, stats) {
    const { spendsByPrevPath, outDir, tmpDir, ramBudgetBytes, removeSpent, onProgress } = ctx

    // Phase 8: spends-by-prevtx → I.dat (sorted), J-raw (unsorted)
    // spends-by-prevtx.dat has no header; its records are sorted by
    // (prevTxid, prevVout), which matches I key order exactly.
    //
    // Skipped entirely when removeSpent=true (the default and only parity
    // seed): the live confirmed path never persists I/J records. The explicit
    // removeSpent=false branch below is NOT a parity seed (fixtures only).
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
            const prevTxid    = rec.subarray(SPD_PREV_TXID, SPD_PREV_TXID + 32)
            const prevVoutBE  = rec.subarray(SPD_PREV_VOUT, SPD_PREV_VOUT + 4)
            const spenderTxid = rec.subarray(SPD_SPENDER_TXID, SPD_SPENDER_TXID + 32)

            // I record: 'I' + prevTxid(32) + prevVoutBE(4) | spenderTxid(32)
            const iBuf = Buffer.allocUnsafe(LAYOUT.I.recordSize)
            iBuf[0] = P_INPUT
            prevTxid   .copy(iBuf, 1, 0, 32)
            prevVoutBE .copy(iBuf, 33, 0, 4)
            spenderTxid.copy(iBuf, 37, 0, 32)
            iOut.writeRecord(iBuf)

            // J record: 'J' + spenderTxid(32) + prevTxid(32) + prevVoutBE(4) | (empty)
            jRaw.write((buf, off) => {
                buf[off] = P_IN_HINT
                spenderTxid.copy(buf, off + 1,  0, 32)
                prevTxid   .copy(buf, off + 33, 0, 32)
                prevVoutBE .copy(buf, off + 65, 0, 4)
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
