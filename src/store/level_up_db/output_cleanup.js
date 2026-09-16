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

const { P_OUTPUT, P_OUT_HINT, P_OUT_DEL, P_HINT_DEL, P_OUT_BLK } = require('./constants')
const { h2b, pb, rangeEnd, toMapKey, idxBuf } = require('./key_codec')

module.exports = {
    async deleteOutputsByHint(txid){
        const txHash8Hex = txid.substring(0, 16)
        const txHash8Buf = h2b(txHash8Hex)
        const prefix     = Buffer.concat([pb(P_OUT_HINT), txHash8Buf])

        const options = {
            gte: prefix,
            lte: rangeEnd(prefix),
            keys: true,
            values: true
        }

        let outputsCount = 0

        for await (const [key, value] of this.db.iterator(options)) {
            // H key layout: [H(1)][txHash8(8)][outputIndex(4)]
            const idxPart = key.slice(9, 13)   // 4-byte output index
            const scriptPubKeyBuf = value       // 32-byte Buffer

            const oKey = Buffer.concat([pb(P_OUTPUT), scriptPubKeyBuf, txHash8Buf, idxPart])
            await this.addTransaction("del", oKey, null)
            await this.addTransaction("del", key, null)
            outputsCount++
        }

        return outputsCount
    },

    async deleteOutputsByHints(txids){
        const counts = await Promise.all(txids.map(txid => this.deleteOutputsByHint(txid)))
        return counts.reduce((sum, n) => sum + n, 0)
    },

    // Deleted output recovery (K / M prefix)

    async processDeletedOutputs(blockHash, recover = true){
        const delMapKey = toMapKey(blockHash)
        if (this.deletedTransactionArray && this.deletedTransactionArray.has(delMapKey)){
            if (recover){
                const innerMap = this.deletedTransactionArray.get(delMapKey)
                innerMap.forEach((value, mapKey) => {
                    const item = this.transactionArray.get(mapKey)
                    if (item){
                        item.value = value
                    } else {
                        // Re-create the put entry. innerMap/transactionArray keys are
                        // latin1-encoded byte strings (see toMapKey), NOT hex: so the
                        // original key Buffer is recovered with 'latin1', the exact
                        // inverse of toMapKey. (Using h2b/'hex' here reinterprets the
                        // bytes as hex digits and writes a corrupted key on recovery.)
                        const keyBuf = Buffer.isBuffer(mapKey) ? mapKey : Buffer.from(mapKey, 'latin1')
                        this.transactionArray.set(mapKey, { type: "put", key: keyBuf, value })
                    }
                })
            }
            this.deletedTransactionArray.delete(delMapKey)
        }

        await this.processDeletedOutputsInDb(blockHash, recover, false)
        await this.processDeletedOutputsInDb(blockHash, recover, true)
    },

    async processDeletedOutputsInDb(blockHash, recover = true, processOutputHints = false){
        // prefixLen = 1 (prefix byte) + 32 (blockHash)
        const prefixBuf = Buffer.concat([
            pb(processOutputHints ? P_HINT_DEL : P_OUT_DEL),
            h2b(blockHash)
        ])

        const options = {
            gte: prefixBuf,
            lte: rangeEnd(prefixBuf),
            keys: true,
            values: true
        }

        for await (const [key, value] of this.db.iterator(options)) {
            if (recover){
                // Strip the prefix+blockHash to get the original key suffix,
                // then prepend the correct single-byte prefix to reconstruct it.
                const suffix = key.slice(33)  // skip [prefix(1)][blockHash(32)]
                const restorePrefix = processOutputHints ? P_OUT_HINT : P_OUTPUT
                const restoreKey = Buffer.concat([pb(restorePrefix), suffix])
                await this.addTransaction("put", restoreKey, value)
            }

            await this.addTransaction("del", key)
        }
    },

    // Delete the O/H entries for every output CREATED in the given block, using
    // the W creation-block reverse index. Called during a reorg to purge outputs
    // born in a rolled-back block that were never spent (K/M recovery only
    // restores outputs spent in the rolled-back block, so without this they
    // would linger as phantom UTXOs and inflate balances permanently). Must run after
    // processDeletedOutputs(recover=true): if an output was both created and spent
    // in this block, recovery re-stages its O/H put and this del then overrides it.
    async removeCreatedOutputsInBlock(blockHash){
        const prefixBuf = Buffer.concat([pb(P_OUT_BLK), h2b(blockHash)])

        const options = {
            gte: prefixBuf,
            lte: rangeEnd(prefixBuf),
            keys: true,
            values: true
        }

        for await (const [key, value] of this.db.iterator(options)) {
            // W key:   [W(1)][blockHash(32)][txHash8(8)][outputIndex(4)]
            // W value: [scriptPubKey(32)]
            const txHash8Buf = key.slice(33, 41)
            const idxBuf     = key.slice(41, 45)
            const scriptBuf  = value

            // O key: [O(1)][scriptPubKey(32)][txHash8(8)][outputIndex(4)]
            const oKey = Buffer.concat([pb(P_OUTPUT), scriptBuf, txHash8Buf, idxBuf])
            // H key: [H(1)][txHash8(8)][outputIndex(4)]
            const hKey = Buffer.concat([pb(P_OUT_HINT), txHash8Buf, idxBuf])

            await this.addTransaction("del", oKey)
            await this.addTransaction("del", hKey)
            await this.addTransaction("del", key)
        }
    },

    // Delete ONLY the W creation-block reverse-index records for an aged-out block.
    // Unlike removeCreatedOutputsInBlock (the reorg path, which also removes the live
    // O/H rows for an orphaned block), this leaves O/H untouched: an aged-out block's
    // outputs may still be unspent and live. The W index is consulted only by the
    // reorg unwind, which can never reach past the undoBlocks window, so W records
    // beyond that window are permanently dead weight (the index otherwise grows with
    // every output ever created, not the live-UTXO set). Queues into the caller's
    // open transaction batch, same as processDeletedOutputs/removeLastStoredBlock.
    async removeCreatedOutputsBlockIndexOnly(blockHash){
        const prefixBuf = Buffer.concat([pb(P_OUT_BLK), h2b(blockHash)])

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
}
