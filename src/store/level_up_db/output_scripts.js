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
 **********************************************************************/

const { EMPTY, KNOWN_SCRIPTS_MAX, P_SCRIPT_BLK, P_BLK_SCRIPT, P_OUTPUT, logger } = require('./constants')
const { kScriptBlk, kScriptBlkFromBuf, kBlkScript, kBlkScriptFromBuf, h2b, pb, rangeEnd, b2h, idxBuf, parseOutputCursor } = require('./key_codec')
const { encodeScriptBlk, decodeScriptBlk, decodeOutput } = require('./value_codec')
const { AddressTooLargeError, InvalidCursorError } = require('./store_errors')
const LevelUpStore = require('../level_up_db.js')

module.exports = {
    // Output script block (S / Z prefix)

    // outputScript may be a Buffer (hot path) or a hex string (mempool / legacy callers).
    async insertOutputScriptBlock(outputScript, blockHash, blockHeight){
        // Mempool transactions have no confirmed block: S/Z prefix tracking is meaningless
        if (!blockHash) return true

        // Recreate the Set to avoid V8 tombstone accumulation from constant add+delete.
        // Covers all three add paths below with a single check per call.
        if (LevelUpStore.knownScripts.size > KNOWN_SCRIPTS_MAX) {
            LevelUpStore.knownScripts = new Set()
        }

        // Normalize the Set key to a latin1-encoded 32-char string when the input
        // is a Buffer. latin1 is half the size of hex and avoids the nibble
        // encoding cost; used only as the in-memory dedup key, never for DB ops.
        const isBuf = Buffer.isBuffer(outputScript)
        const scriptKey = isBuf ? outputScript.toString('latin1') : outputScript

        // Tier 0: known to exist from a previous batch (pure in-memory, no DB hit)
        if (LevelUpStore.knownScripts.has(scriptKey)) {
            LevelUpStore.knownScriptsHits++
            return true
        }
        LevelUpStore.knownScriptsMisses++

        const sKey = isBuf ? kScriptBlkFromBuf(outputScript) : kScriptBlk(outputScript)

        // Tier 1: in current batch (avoids a real DB read)
        if (this.getTransactionValue(sKey) !== null) {
            LevelUpStore.knownScripts.add(scriptKey)
            return true
        }

        // Tier 2: DB lookup. abstract-level .get returns undefined on a miss;
        // a defined value means the script-block entry already exists. Real
        // I/O errors propagate.
        if (await this.db.get(sKey) !== undefined) {
            LevelUpStore.knownScripts.add(scriptKey)
            return true  // already exists
        }

        // New script: insert and remember
        await this.addTransaction("put", sKey, encodeScriptBlk(blockHeight))
        const zKey = isBuf ? kBlkScriptFromBuf(blockHash, outputScript) : kBlkScript(blockHash, outputScript)
        await this.addTransaction("put", zKey, EMPTY)
        LevelUpStore.knownScripts.add(scriptKey)

        return true
    },

    async getOutputScriptBlock(outputScript){
        const buf = await this.db.get(kScriptBlk(outputScript))
        if (buf === undefined) return null
        return decodeScriptBlk(buf)
    },

    async removeOutputScriptsInBlock(blockHash){
        const prefixBuf = Buffer.concat([pb(P_BLK_SCRIPT), h2b(blockHash)])

        const options = {
            gte: prefixBuf,
            lte: rangeEnd(prefixBuf),
            keys: true,
            values: true
        }

        let deleted = 0
        for await (const [key] of this.db.iterator(options)) {
            // Z key: [Z(1)][blockHash(32)][scriptPubKey(32)]
            const scriptBuf = key.slice(33)
            await this.addTransaction("del", Buffer.concat([pb(P_SCRIPT_BLK), scriptBuf]))
            await this.addTransaction("del", key)
            deleted++
        }

        // Reset the in-memory existence cache whenever on-disk S/Z entries are
        // deleted (reorg path). Without this, a script that appeared in the
        // rolled-back block stays in knownScripts, causing insertOutputScriptBlock
        // to Tier-0 hit and skip recreating S/Z for the replacement block's tx,
        // permanently losing that script's first-seen height. A full reset is
        // safe: the cache is a read-acceleration shortcut and cannot produce a
        // wrong answer after rebuilding from disk.
        if (deleted > 0) {
            LevelUpStore.knownScripts = new Set()
        }
    },

    // Delete ONLY the Z block->script reverse-index records for an aged-out block.
    // Unlike removeOutputScriptsInBlock (the reorg path, which also deletes the
    // paired S first-seen records), this leaves S intact: S backs the live
    // getFirstSeen/getOutputScriptBlock query and must survive for the life of
    // the store. Z's only reader is the reorg unwind, which can never reach past
    // the undoBlocks window, so Z records beyond that window are permanently dead
    // weight (the index otherwise grows with every distinct script ever seen,
    // not the live set). Mirrors removeCreatedOutputsBlockIndexOnly for W.
    // Queues into the caller's open transaction batch. knownScripts is NOT reset
    // here: the S records the cache fronts are untouched, so the cache stays
    // truthful.
    async removeOutputScriptsBlockIndexOnly(blockHash){
        const prefixBuf = Buffer.concat([pb(P_BLK_SCRIPT), h2b(blockHash)])

        const options = {
            gte: prefixBuf,
            lte: rangeEnd(prefixBuf),
            keys: true,
            values: false
        }

        for await (const [key] of this.db.iterator(options)) {
            await this.addTransaction("del", key)
        }
    },

    // Queries

    async getOutputsScriptPubKey(scriptPubKey, { limit = null, after = null, maxOutputs = null } = {}){
        const outputs = []
        const prefix  = Buffer.concat([pb(P_OUTPUT), h2b(scriptPubKey)])
        const options = {
            lte: rangeEnd(prefix),
            keys: true,
            values: true
        }

        // Pagination cursor: resume strictly after the last key the previous page
        // returned. Reconstruct the full O key from the cursor and use an exclusive
        // lower bound (`gt`) so the cursor row is not repeated.
        if (after != null) {
            const parsed = parseOutputCursor(after)
            if (!parsed) throw new InvalidCursorError(after)
            options.gt = Buffer.concat([prefix, h2b(parsed.txHash8Hex), idxBuf(parsed.vout)])
        } else {
            options.gte = prefix
        }

        // Bounded page: let LevelDB stop scanning at `limit` rows. When unbounded,
        // `maxOutputs` is a hard safety ceiling: refuse rather than build a
        // multi-million-entry array that would OOM the process.
        const pageLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : null
        if (pageLimit != null) options.limit = pageLimit

        for await (const [key, value] of this.db.iterator(options)) {
            if (pageLimit == null && maxOutputs != null && outputs.length >= maxOutputs) {
                throw new AddressTooLargeError(maxOutputs)
            }
            // O key: [O(1)][scriptPubKey(32)][txHash8(8)][outputIndex(4)]
            const txHash8Hex = b2h(key.slice(33, 41))
            const n          = key.readUInt32BE(41)
            const decoded    = decodeOutput(value)

            outputs.push({
                txid:     txHash8Hex,
                fullTxid: decoded.t || null,
                vout:     n,
                value:    decoded.v,
                height:   decoded.h,
                coinbase: decoded.cb
            })
        }

        return outputs
    },

    // Generic key-pattern scan (used by API)
    // pattern: hex string representing the binary key prefix

    async getValuesFromKeyPattern(pattern, { maxValues = null } = {}){
        const patternBuf = Buffer.isBuffer(pattern) ? pattern : h2b(pattern)

        // Guard the DECODED byte length, not the input string length:
        // Buffer.from(str, 'hex') silently stops at the first non-hex character,
        // so a long-but-invalid string can decode to a 0/1-byte prefix whose
        // range (gte=prefix, lte=rangeEnd) covers most or all of the database.
        if (patternBuf.length < 2) {
            const e = new Error('pattern must decode to at least 2 bytes of key prefix')
            e.code = 'BAD_REQUEST'
            throw e
        }

        const values = []
        const options = {
            gte: patternBuf,
            lte: rangeEnd(patternBuf),
            keys: true,
            values: true
        }

        try {
            for await (const [key, value] of this.db.iterator(options)) {
                // `maxValues` is a hard safety ceiling, mirroring the maxOutputs
                // guard in getOutputsScriptPubKey: refuse rather than build a
                // multi-million-entry array that would OOM the process.
                if (maxValues != null && values.length >= maxValues) {
                    throw new AddressTooLargeError(maxValues)
                }
                values.push({
                    key:   b2h(key),
                    value: b2h(value)
                })
            }
        } catch (err) {
            logger.info("Error getting values from patterns")
            logger.info(err)
            throw err
        }

        return values
    },
}
