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

const { DEBUG_TRACE, logger, OUTPUT_CACHE_MAX } = require('./constants')
const { kOutput, kOutputFromBuf, kOutHint, kOutBlk, kBlock, kHintDel, kOutDelFromBuf } = require('./key_codec')
const { encodeOutput, encodeOutHint, decodeBlock, decodeOutput } = require('./value_codec')
const LevelUpStore = require('../level_up_db.js')

module.exports = {
    // Output (O prefix)

    // output.scriptPubKey may be a Buffer (hot path) or a hex string (mempool / legacy callers).
    async insertOutput(output) {
        const oVal = encodeOutput(output.value, output.height, output.fullTxHash || null, output.coinbase === true)

        // Populate the recent-output cache so Phase 2 of removeOutputsWithInputsBatch
        // can absorb spends without a DB read. outputIndex is packed into 2 BMP
        // chars (high/low 16 bits) rather than ":" + String(n) to avoid a
        // string-conversion hot spot seen in profiling, while covering the full
        // 32-bit range.
        //
        // outputCache is a process-global static shared by the confirmed and
        // mempool stores; the mempool store also calls insertOutput (height=-1).
        // Correctness relies on block Pass 1 overwriting any mempool entry with
        // the confirmed height before Pass 2 reads it (a confirmed block can only
        // spend an already-mined output). The reorg path deletes O records for
        // orphaned outputs but does not evict the cache; those entries are never
        // re-read because the spending tx is also gone after the reorg.
        //
        // Never cache a mempool (unconfirmed) output: it is the only caller that
        // passes height<0, and a concurrent mempool re-cache after Pass 1 wrote
        // the confirmed height could make Pass 2 archive a K restore record with
        // a bogus height=-1, later restored on reorg with a wrong confirmation
        // count. The mempool store never reads this cache, so skipping the write
        // for height<0 removes the only writer of bad heights.
        if (output.height != null && output.height >= 0) {
            const _oi = output.outputIndex
            const cacheKey = output.txHash + String.fromCharCode((_oi >>> 16) & 0xFFFF, _oi & 0xFFFF)
            const cache = LevelUpStore.outputCache
            cache.set(cacheKey, oVal)
            if (cache.size > OUTPUT_CACHE_MAX) {
                // Recreate the Map to avoid V8 tombstone accumulation from
                // constant add+delete patterns, which causes steady degradation.
                LevelUpStore.outputCache = new Map()
            }
        }

        const oKey = Buffer.isBuffer(output.scriptPubKey)
            ? kOutputFromBuf(output.scriptPubKey, output.txHash, output.outputIndex)
            : kOutput(output.scriptPubKey, output.txHash, output.outputIndex)
        if (DEBUG_TRACE) {
            const shHex = Buffer.isBuffer(output.scriptPubKey) ? output.scriptPubKey.toString('hex') : output.scriptPubKey
            logger.info(`TRACE insertOutput db=${this.dbName} sh=${shHex} tx8=${output.txHash} idx=${output.outputIndex} val=${output.value} h=${output.height}`)
        }
        return await this.addTransaction("put", oKey, oVal)
    },

    // Output hint (H prefix)

    // output.scriptPubKey may be a Buffer (hot path) or a hex string.
    async insertOutputHint(output){
        const hintVal = Buffer.isBuffer(output.scriptPubKey)
            ? output.scriptPubKey
            : encodeOutHint(output.scriptPubKey)
        return await this.addTransaction(
            "put",
            kOutHint(output.txHash, output.outputIndex),
            hintVal
        )
    },

    // Output creation-block reverse index (W prefix)

    // Records which block created this output so a reorg can find and delete the
    // O/H entries for outputs born in a rolled-back block but never spent (which
    // K/M spend-recovery alone cannot reach). Confirmed outputs only (mempool
    // outputs (no blockHash) are skipped, like the S/Z script-block index.
    // Note: this only heals reorgs going forward; outputs created before this
    // index existed have no W entry, so a node that reorged in the past must be
    // re-indexed to clear any pre-existing phantom UTXOs.
    // output.scriptPubKey may be a Buffer (hot path) or a hex string.
    async insertOutputBlock(output){
        if (!output.blockHash) return true
        const wVal = Buffer.isBuffer(output.scriptPubKey)
            ? output.scriptPubKey
            : encodeOutHint(output.scriptPubKey)
        return await this.addTransaction(
            "put",
            kOutBlk(output.blockHash, output.txHash, output.outputIndex),
            wVal
        )
    },

    // Output + hint removal (REMOVE_SPENT path)

    // Cross-block in-memory spend recovery: when an output is created and spent
    // in the SAME batch, the spend takes the in-memory path and only survives
    // via the per-block entry in deletedTransactionArray, which endTransaction
    // discards on commit. A same-block create+spend is harmless (a reorg can
    // never split one block), but a batch spans up to
    // DB_TRANSACTION_BLOCKS_QUANTITY blocks, so a create at block N and a spend
    // at block N+k can be split by a reorg between them; with no K/M records on
    // disk, processDeletedOutputs finds nothing to restore and the balance is
    // silently lost. Fix: when the spent output's creation block is strictly
    // earlier than the spend block, write the same M/K restore records the
    // DB/archive branch writes, keyed by the spend blockHash, so a reorg
    // restores it normally; cleanupAgedBlocks still prunes them once they age
    // out. spendBlockHeight comes from this batch's B record; createdHeight
    // from the spent output's value, since the input object carries no height.
    // Cross-block in-memory spend recovery.
    //
    // When an output is created and spent within the SAME uncommitted batch the
    // spend takes the in-memory path: the O/H entries are dropped from the
    // staging map and the only restore record is the per-spend-block entry in
    // deletedTransactionArray. That in-memory record is discarded the moment the
    // batch commits (endTransaction nulls the maps), so it cannot survive to a
    // later reorg. For a same-block create+spend that is harmless: a reorg can
    // never split a single block, so the output never needs restoring on its own.
    // But a batch spans up to DB_TRANSACTION_BLOCKS_QUANTITY blocks, so a create
    // at block N and a spend at block N+k (k>0) is also in-memory yet CAN be split
    // by a reorg to a fork between N and N+k. After commit there are no K/M records
    // on disk, so processDeletedOutputs finds nothing to restore and the spent
    // output's balance is silently lost.
    //
    // Fix: when the spent output was created in a strictly earlier block than the
    // spending input, write the same M (hint) + K (output) restore records the
    // DB/archive branch writes, keyed by the spend blockHash. A reorg that rolls
    // back the spend block then restores the output exactly as for a normal
    // committed spend. The records are still pruned by cleanupAgedBlocks once the
    // spend block ages out of the undoBlocks window.
    //
    // spendBlockHeight is read from the B record inserted for this block earlier
    // in the same batch; createdHeight is decoded from the spent output's value.
    // Both are needed because the input object carries no height.
    spendBlockHeightInBatch(blockHashHex){
        const blkVal = this.getTransactionValue(kBlock(blockHashHex))
        if (blkVal == null) return null
        return decodeBlock(blkVal).h
    },

    // Write the M/K reorg-restore records for an in-memory spend whose output was
    // created in an earlier block of the same batch. Returns true when records
    // were written (cross-block), false when skipped (same-block or unknown
    // heights). oVal is the spent output's stored value (encodeOutput bytes).
    async writeCrossBlockSpendRecovery(input, scriptPubKeyBuf, oVal){
        if (oVal == null) return false
        const createdHeight = decodeOutput(oVal).h          // creation block height
        const spendHeight = this.spendBlockHeightInBatch(input.blockHash)
        // Only a strictly-earlier creation block is reorg-splittable. If either
        // height is unknown, or the spend is same-block, skip (no record needed).
        if (createdHeight == null || createdHeight < 0 || spendHeight == null) return false
        if (createdHeight >= spendHeight) return false
        const mKey = kHintDel(input.blockHash, input.prevTxHash, input.prevOutputIndex)
        const kKey = kOutDelFromBuf(input.blockHash, scriptPubKeyBuf, input.prevTxHash, input.prevOutputIndex)
        await this.addTransaction("put", mKey, scriptPubKeyBuf)
        await this.addTransaction("put", kKey, oVal)
        return true
    },

    async removeOutputWithInput(input) {
        const hKey = kOutHint(input.prevTxHash, input.prevOutputIndex)
        const mKey = kHintDel(input.blockHash, input.prevTxHash, input.prevOutputIndex)

        // abstract-level .get returns undefined on a missing key (it does NOT
        // throw). Real I/O errors still reject the promise and propagate up;
        // we deliberately do NOT swallow them here, unlike the previous
        // catch-all which treated every error as "not committed yet".
        const scriptPubKeyBuf = await this.db.get(hKey)                            // 32-byte Buffer or undefined
        let oVal = undefined
        let oKey = null
        if (scriptPubKeyBuf !== undefined) {
            oKey = kOutputFromBuf(scriptPubKeyBuf, input.prevTxHash, input.prevOutputIndex)
            oVal = await this.db.get(oKey)
        }

        if (scriptPubKeyBuf === undefined || oVal === undefined) {
            // Output not yet committed: check in-memory transaction map
            const inMemScript = this.getTransactionValue(hKey)
            if (inMemScript != null){
                const inMemOKey = kOutputFromBuf(inMemScript, input.prevTxHash, input.prevOutputIndex)
                // Capture the staged output value BEFORE removal so a cross-block
                // spend can write durable K/M restore records (see
                // writeCrossBlockSpendRecovery). Same-block spends write nothing.
                const inMemOVal = this.getTransactionValue(inMemOKey)
                if (!this.removeTransaction(inMemOKey, input.blockHash)){
                    throw Error("Missing output match for input "+JSON.stringify(input))
                }
                if (!this.removeTransaction(hKey, input.blockHash)){
                    throw Error("Missing outputHintKey match for input "+JSON.stringify(input))
                }
                await this.writeCrossBlockSpendRecovery(input, inMemScript, inMemOVal)
            } else if (scriptPubKeyBuf !== undefined && oVal === undefined) {
                // H present on disk, O missing: a live-store divergence, NOT the benign
                // pre-REMOVE_SPENT legacy case (the hint key is present, not missing). Mirror
                // the batch path (delOutput) message VERBATIM so an operator grepping for the
                // divergence signal catches occurrences on both code paths. Leave O/H intact -
                // deleting H with no K/M undo record would be unrecoverable on reorg unwind.
                logger.info("Warning: Missing output value for input " + JSON.stringify(input) + " while its outputHintKey is present - leaving O/H records intact, not deleting without an undo record")
            } else {
                logger.info("Warning: Missing outputHintKey for input "+JSON.stringify(input)+" - output may have been indexed before REMOVE_SPENT was enabled")
            }
            return true
        }

        const kKey = kOutDelFromBuf(input.blockHash, scriptPubKeyBuf, input.prevTxHash, input.prevOutputIndex)

        // Stage for deferred deletion: will be purged after batch commit
        await this.addTransaction("put", mKey, scriptPubKeyBuf)
        await this.addTransaction("put", kKey, oVal)
        await this.addTransaction("del", oKey)
        await this.addTransaction("del", hKey)
        return true
    },

    // Batch version of removeOutputWithInput: collects all inputs for a block,
    // resolves hints and outputs with 2 getMany calls instead of N individual db.get().
    async removeOutputsWithInputsBatch(inputs) {
        if (inputs.length === 0) return 0

        const resolved = new Array(inputs.length)
        const hintDbKeys = []
        const hintDbIndices = []

        // Phase 1: resolve all hint keys (scriptPubKey lookup)
        const _tHint = Date.now()
        for (let i = 0; i < inputs.length; i++) {
            const inp = inputs[i]
            const hKey = kOutHint(inp.prevTxHash, inp.prevOutputIndex)
            resolved[i] = { hKey }

            // Try in-memory (same-block spend)
            const inMem = this.getTransactionValue(hKey)
            if (inMem != null) {
                resolved[i].scriptPubKeyBuf = inMem
                resolved[i].inMem = true
                continue
            }

            // Queue for batch DB read
            hintDbKeys.push(hKey)
            hintDbIndices.push(i)
        }

        // Batch DB read for hint misses
        if (hintDbKeys.length > 0) {
            const hintValues = await this.db.getMany(hintDbKeys)
            for (let j = 0; j < hintDbKeys.length; j++) {
                const i = hintDbIndices[j]
                if (hintValues[j] == null) {
                    logger.info("Warning: Missing outputHintKey for input " + JSON.stringify(inputs[i]) + " - output may have been indexed before REMOVE_SPENT was enabled")
                    resolved[i] = null
                    continue
                }
                resolved[i].scriptPubKeyBuf = hintValues[j]
            }
        }
        LevelUpStore.parseInBuckets.hintRead += Date.now() - _tHint

        // Phase 2: resolve all output values
        // First check the in-memory output cache (recently-written outputs).
        // Most spends hit recently-created UTXOs (locality), so this absorbs
        // a large fraction of the lookups without touching the DB.
        const _tOut = Date.now()
        const outputDbKeys = []
        const outputDbIndices = []
        const cache = LevelUpStore.outputCache

        for (let i = 0; i < inputs.length; i++) {
            if (!resolved[i] || !resolved[i].scriptPubKeyBuf) continue
            if (resolved[i].inMem) continue

            const inp = inputs[i]
            const r = resolved[i]
            r.oKey = kOutputFromBuf(r.scriptPubKeyBuf, inp.prevTxHash, inp.prevOutputIndex)

            // Cache lookup (must match the fromCharCode encoding used in insertOutput)
            const _pi = inp.prevOutputIndex
            const cacheKey = inp.prevTxHash + String.fromCharCode((_pi >>> 16) & 0xFFFF, _pi & 0xFFFF)
            const cached = cache.get(cacheKey)
            if (cached !== undefined) {
                r.oVal = cached
                cache.delete(cacheKey)   // spent: drop from cache
                LevelUpStore.outputCacheHits++
                continue
            }
            LevelUpStore.outputCacheMisses++

            outputDbKeys.push(r.oKey)
            outputDbIndices.push(i)
        }

        // Batch DB read for cache misses
        if (outputDbKeys.length > 0) {
            const outputValues = await this.db.getMany(outputDbKeys)
            for (let j = 0; j < outputDbKeys.length; j++) {
                resolved[outputDbIndices[j]].oVal = outputValues[j]
            }
        }
        LevelUpStore.parseInBuckets.outRead += Date.now() - _tOut

        // Phase 3: stage all deletes
        const _tStage = Date.now()
        for (let i = 0; i < inputs.length; i++) {
            if (!resolved[i]) continue
            const inp = inputs[i]
            const r = resolved[i]

            if (r.inMem) {
                const inMemOKey = kOutputFromBuf(r.scriptPubKeyBuf, inp.prevTxHash, inp.prevOutputIndex)
                if (DEBUG_TRACE) {
                    logger.info(`TRACE delOutput db=${this.dbName} path=inMem sh=${r.scriptPubKeyBuf.toString('hex')} tx8=${inp.prevTxHash} idx=${inp.prevOutputIndex} blk=${inp.blockHash}`)
                }
                // Capture the staged output value BEFORE removal so a cross-block
                // spend writes durable K/M restore records (see
                // writeCrossBlockSpendRecovery). Same-block spends write nothing.
                const inMemOVal = this.getTransactionValue(inMemOKey)
                // Check both removals and fail with the same outpoint-naming
                // diagnostic the single-input path (removeOutputWithInput) throws,
                // instead of an opaque TypeError / a silently-ignored false return.
                if (!this.removeTransaction(inMemOKey, inp.blockHash)){
                    throw Error("Missing output match for input "+JSON.stringify(inp))
                }
                if (!this.removeTransaction(r.hKey, inp.blockHash)){
                    throw Error("Missing outputHintKey match for input "+JSON.stringify(inp))
                }
                await this.writeCrossBlockSpendRecovery(inp, r.scriptPubKeyBuf, inMemOVal)
                continue
            }

            if (r.oVal == null) {
                if (DEBUG_TRACE) {
                    logger.info(`TRACE delOutput db=${this.dbName} path=noOval sh=${r.scriptPubKeyBuf.toString('hex')} tx8=${inp.prevTxHash} idx=${inp.prevOutputIndex} blk=${inp.blockHash}`)
                }
                // H present, O missing on disk: the single-input path
                // (removeOutputWithInput) treats this as "do nothing" rather than
                // deleting, because deleting here would drop the live H record
                // with no K/M undo record to restore it on reorg unwind. Match
                // that: leave both records intact and log loudly instead of
                // silently creating an unrecoverable-on-reorg spend.
                logger.info("Warning: Missing output value for input " + JSON.stringify(inp) + " while its outputHintKey is present - leaving O/H records intact, not deleting without an undo record")
                continue
            }

            const mKey = kHintDel(inp.blockHash, inp.prevTxHash, inp.prevOutputIndex)
            const kKey = kOutDelFromBuf(inp.blockHash, r.scriptPubKeyBuf, inp.prevTxHash, inp.prevOutputIndex)
            if (DEBUG_TRACE) {
                logger.info(`TRACE delOutput db=${this.dbName} path=archive sh=${r.scriptPubKeyBuf.toString('hex')} tx8=${inp.prevTxHash} idx=${inp.prevOutputIndex} blk=${inp.blockHash}`)
            }
            await this.addTransaction("put", mKey, r.scriptPubKeyBuf)
            await this.addTransaction("put", kKey, r.oVal)
            await this.addTransaction("del", r.oKey)
            await this.addTransaction("del", r.hKey)
        }
        LevelUpStore.parseInBuckets.stage += Date.now() - _tStage

        return inputs.length
    },
}
