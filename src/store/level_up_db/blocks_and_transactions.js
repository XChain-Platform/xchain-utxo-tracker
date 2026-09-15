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

const bs = require("binary-search")
const { P_TX } = require('./constants')
const { toMapKey, kBlock, kTx, h2b, b2h, pb, rangeEnd } = require('./key_codec')
const { encodeBlock, decodeBlock, encodeTx, decodeTx } = require('./value_codec')

module.exports = {
    // Returns the stored value for a key currently pending in transactionArray.
    // Null-safe: with no open batch (transactionArray === null) there is nothing
    // staged, so return null rather than throwing on a bare .get().
    getTransactionValue(key){
        if (this.transactionArray == null) return null
        const item = this.transactionArray.get(toMapKey(key))
        return item != null ? item.value : null
    },

    async addTransaction(type, key, value=null){
        const mapKey = toMapKey(key)
        const newItem = { type, key, value }

        if (this.transactionArray != null){
            this.transactionArray.set(mapKey, newItem)
            return true
        } else {
            switch(type){
                case "put":
                    await this.db.put(key, value)
                    break
                case "del":
                    await this.db.del(key)
                    break
                default:
                    throw new Error("Unknown db transaction type: "+type)
            }
            return true
        }
    },

    // Cancel a staged write for `key` if (and only if) it is a PUT created earlier
    // in this same batch, i.e. a create+remove within one batch that nets to
    // nothing. It must NOT cancel a staged DEL: doing so made a re-run of the same
    // deletion idempotency-breaking. When the P-key crash-recovery replays a
    // pendingKMCleanup list that also gets re-shifted by addToLastBlocks, a block
    // hash can be cleaned twice in one transaction; a blind cancel of the first
    // del left the N record on disk and the cleanup falsely reported success.
    // Returning false for a staged del makes the caller fall through and re-stage
    // the del (an idempotent no-op that still commits the deletion).
    removeTransactionIfExists(key){
        const mapKey = toMapKey(key)
        if (this.transactionArray && this.transactionArray.has(mapKey)){
            const item = this.transactionArray.get(mapKey)
            if (item && item.type === 'put'){
                return this.transactionArray.delete(mapKey)
            }
        }
        return false
    },

    removeTransaction(key, deletedKey){
        const mapKey    = toMapKey(key)
        const delMapKey = toMapKey(deletedKey)

        // Guard first: if the staged put is absent, return false instead of
        // dereferencing undefined (`this.transactionArray.get(mapKey).value` threw
        // a bare, outpoint-less TypeError). Placing the guard before touching
        // deletedTransactionArray also avoids staging an undefined undo value.
        if (!this.transactionArray.has(mapKey)){
            return false
        }

        if (!this.deletedTransactionArray.has(delMapKey)){
            this.deletedTransactionArray.set(delMapKey, new Map())
        }

        this.deletedTransactionArray.get(delMapKey).set(mapKey, this.transactionArray.get(mapKey).value)

        return this.transactionArray.delete(mapKey)
    },

    // Block (B prefix)

    async insertBlock(block) {
        return await this.addTransaction(
            "put",
            kBlock(block.hash),
            encodeBlock(block.height, block.timestamp, block.previousHash)
        )
    },

    async deleteBlock(blockHash) {
        return await this.addTransaction("del", kBlock(blockHash), null)
    },

    async getBlock(blockHash){
        const buf = await this.db.get(kBlock(blockHash))
        if (buf === undefined) return null
        return decodeBlock(buf)
    },

    // Transaction (T prefix)

    async insertTransaction(tx) {
        return await this.addTransaction(
            "put",
            kTx(tx.hash.substring(0, 16)),
            encodeTx(tx.blockHash)
        )
    },

    async deleteTransaction(txid) {
        return await this.addTransaction("del", kTx(txid.substring(0, 16)), null)
    },

    // Returns entries as { txid: "T"+txHash8Hex, block_hash: hex }
    // Caller strips the leading "T" with .substr(1) to get txHash8Hex.
    async getTransactions(txHashPrefix){
        const transactions = []
        const prefix = Buffer.concat([pb(P_TX), h2b(txHashPrefix)])
        const options = {
            gte: prefix,
            lte: rangeEnd(prefix),
            keys: true,
            values: true
        }

        for await (const [key, value] of this.db.iterator(options)) {
            const txHash8Hex = b2h(key.slice(1))
            const blockHashHex = decodeTx(value).bh
            transactions.push({
                txid: 'T' + txHash8Hex,
                block_hash: blockHashHex
            })
        }

        return transactions
    },

    async getTransaction(txHashWithPrefix){
        // Accepts full key as hex string (prefix included) for backward compatibility
        const value = await this.db.get(h2b(txHashWithPrefix))
        return value === undefined ? null : value
    },

    // Mempool helpers

    async deleteAndCompareTxsNotInList(txidList){
        const deletedTxs = []
        const options = {
            gte: pb(P_TX),
            lte: rangeEnd(pb(P_TX)),
            keys: true,
            values: false
        }

        for await (const [key] of this.db.iterator(options)) {
            const txid = b2h(key.slice(1))   // 16-char hex (txHash8)
            // binary-search convention: comparator(element, needle) returns
            // negative when element < needle (search to the right). The prior
            // form `needle.localeCompare(element_first16)` had the sign
            // INVERTED, and the result check `== -1` only matched the
            // not-found-at-insertion-index-0 case. Together this caused
            // ~half of all not-found needles to be misclassified as found
            // (returning -2 for insertion at index 1). Use `< 0` for any
            // not-found return and an element-vs-needle comparator.
            const txidIndex = bs(txidList, txid, function(element, needle) {
                return element.substring(0, 16).localeCompare(needle)
            })

            if (txidIndex < 0) {
                await this.deleteTransaction(txid)
                deletedTxs.push(txid)
            } else {
                txidList.splice(txidIndex, 1)
            }
        }

        const [inputsDeleted, outputsDeleted] = await Promise.all([
            this.deleteInputsByHints(deletedTxs),
            this.deleteOutputsByHints(deletedTxs),
        ])

        return { transactionsDeleted: deletedTxs.length, outputsDeleted, inputsDeleted }
    },
}
