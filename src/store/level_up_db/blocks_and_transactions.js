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
const { P_TX, P_OUT_BLK, P_TX_BLOCK_RECOVERY } = require('./constants')
const { toMapKey, kBlock, kTx, kTxExact, kTxBlockRecovery, h2b, b2h, pb, rangeEnd } = require('./key_codec')
const { encodeBlock, decodeBlock, encodeTx, decodeTx } = require('./value_codec')

const TXID_HEX_RE = /^[0-9a-f]{64}$/

// X maps a full txid to its block. Y records the full txids indexed by each
// block so rollback can remove only that block's T and X entries. Both key
// builders live in key_codec.js and share the layout version boundary with T.

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

    // Also purges the T/X (exact txid->block) records for every tx created in
    // blockHash: every production caller of deleteBlock is unwinding that
    // block entirely, so a B deletion with no matching cleanup would leave
    // getTxBlock resolving txids into a block that no longer exists.
    async deleteBlock(blockHash) {
        await this.deleteTransactionsInBlock(blockHash)
        return await this.addTransaction("del", kBlock(blockHash), null)
    },

    async getBlock(blockHash){
        const buf = await this.db.get(kBlock(blockHash))
        if (buf === undefined) return null
        return decodeBlock(buf)
    },

    // Transaction (T prefix)

    // T key: [T][txid(32)]; value: [blockHash(32)][fullTxid(32)] = 64 bytes.
    // Read by getTransactions/getTransaction and mempool tracking. The
    // exact-match reader (getTxBlock) reads the X record below. The Y record
    // lets a later rollback confirm which txids this block indexed (see
    // deleteTransactionsInBlock). A bulk seed with its tx index off writes the
    // 32-byte T value (block hash only) and no X or Y; every T reader decodes
    // only the first 32 bytes, and getTxBlock reads such a tx as unindexed
    // because it has no X record (see README.md's Upgrading section). Two txs
    // never share a T key unless they share the whole txid.
    // A blockHash-less (mempool) insert writes T only, like the S/Z/W writers:
    // X and Y have no reader in the mempool store and no delete path there, so
    // writing them would grow that store by every mempool tx ever seen.
    async insertTransaction(tx) {
        const tWrite = await this.addTransaction(
            "put",
            kTx(tx.hash),
            Buffer.concat([encodeTx(tx.blockHash), h2b(tx.hash)])
        )
        if (!tx.blockHash) return tWrite
        await this.addTransaction("put", kTxExact(tx.hash), encodeTx(tx.blockHash))
        return await this.addTransaction("put", kTxBlockRecovery(tx.blockHash, tx.hash), h2b(tx.hash))
    },

    // Deletes the T and X records for a txid with no per-block context (mempool
    // cleanup and mempool-eviction diffing, neither of which knows a blockHash).
    // A mempool entry has no X or Y (insertTransaction writes T only without a
    // blockHash), so the X delete is a no-op there. The confirmed-chain rollback
    // (deleteTransactionsInBlock) calls this only for a block with no Y record;
    // with one it checks each record's block first (deleteTxBlockRecord).
    async deleteTransaction(txid) {
        const txidLower = txid.toLowerCase()
        await this.addTransaction("del", kTxExact(txidLower), null)
        return await this.addTransaction("del", kTx(txidLower), null)
    },

    // Deletes the T (exact txid->block) records for every transaction created
    // in blockHash, via the W creation-block reverse index (every transaction
    // has at least one output, so its txid always appears there). Called
    // from deleteBlock; kept as its own method (mirroring
    // removeCreatedOutputsInBlock's separate W scan over the O/H records) so
    // it stays independently testable.
    async deleteTransactionsInBlock(blockHash) {
        const prefixBuf = Buffer.concat([pb(P_OUT_BLK), h2b(blockHash)])
        const options = {
            gte: prefixBuf,
            lte: rangeEnd(prefixBuf),
            keys: true,
            values: false
        }

        const seenTxids = new Set()
        for await (const [key] of this.db.iterator(options)) {
            // W key: [W(1)][blockHash(32)][txid(32)][outputIndex(4)]
            const txidHex = b2h(key.slice(33, 65))
            // A tx with several outputs has one W record per output, all
            // adjacent in key order; its T/X/Y records are reversed once.
            if (seenTxids.has(txidHex)) continue
            seenTxids.add(txidHex)
            await this.deleteTxBlockRecord(txidHex, blockHash)
        }

        return seenTxids.size
    },

    // Reverses exactly what insertTransaction wrote for this (blockHash, txid)
    // pair. With no Y record (a bulk-seeded block without one) the T and X
    // records go unconditionally. With one, T and X go only while they still
    // point at this block: a later block carrying the same txid may have taken
    // the slot over, and that block has not been rolled back.
    async deleteTxBlockRecord(txidHex, blockHash) {
        const recoveryKey = kTxBlockRecovery(blockHash, txidHex)
        const recoveredTxid = await this.db.get(recoveryKey)

        // No Y record: the block was bulk-seeded without one, or has aged past
        // the undo window, so there is nothing to check the slot's owner against.
        if (recoveredTxid === undefined) {
            return await this.deleteTransaction(txidHex)
        }

        // Clear T only while it still names this block: a later block carrying
        // the same txid may own the slot now, and it is not being rolled back.
        const tValue = await this.db.get(kTx(txidHex))
        if (tValue !== undefined && decodeTx(tValue).bh === blockHash) {
            await this.addTransaction("del", kTx(txidHex), null)
        }
        // The same ownership check for the exact-match X record.
        const xValue = await this.db.get(kTxExact(txidHex))
        if (xValue !== undefined && decodeTx(xValue).bh === blockHash) {
            await this.addTransaction("del", kTxExact(txidHex), null)
        }
        return await this.addTransaction("del", recoveryKey, null)
    },

    // Prunes a block's Y records once it ages out of the undo window, leaving T
    // and X intact (getTxBlock still reads X). Y's only reader is the reorg
    // unwind above, which cannot reach past that window, so they are dead weight.
    async removeTxBlockRecoveryIndexOnly(blockHash) {
        const prefixBuf = Buffer.concat([pb(P_TX_BLOCK_RECOVERY), h2b(blockHash)])
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

    // Exact full-txid to block lookup. Returns { block_hash, block_height, sync }
    // or null: null on no record, on a legacy (pre-X-record) txid that cannot
    // be found in the exact-match index, or when the record's block was
    // itself rolled back. `sync` carries the store's own last-committed tip
    // (independent of whether it agrees with this tx's block) so a caller can
    // tell a fresh answer from one served while the tracker's own tip
    // pointer is stale or behind.
    async getTxBlock(txid) {
        if (typeof txid !== 'string') return null
        const txidLower = txid.toLowerCase()
        if (!TXID_HEX_RE.test(txidLower)) return null

        const buf = await this.db.get(kTxExact(txidLower))
        if (buf === undefined) return null

        const blockHashHex = decodeTx(buf).bh
        const block = await this.getBlock(blockHashHex)
        if (block === null) return null

        return {
            block_hash: blockHashHex,
            block_height: block.h,
            sync: {
                committed_height: await this.getLastBlockHeight(),
                committed_hash: await this.getLastBlockHash()
            }
        }
    },

    // Returns entries as { txid: "T"+txidHex, block_hash: hex }
    // Caller strips the leading "T" with .substr(1) to get the txid.
    // txHashPrefix is any whole-byte hex prefix of a txid; the scan returns every
    // T record whose txid starts with it, in key (txid) order.
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
            const txidHex = b2h(key.slice(1))
            const blockHashHex = decodeTx(value).bh
            transactions.push({
                txid: 'T' + txidHex,
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

    // Deletes stored txs missing from the sorted txidList and splices the stored ones out of it.
    // keepOnly runs the splice alone and deletes nothing.
    async deleteAndCompareTxsNotInList(txidList, { keepOnly = false } = {}){
        const deletedTxs = []
        const options = {
            gte: pb(P_TX),
            lte: rangeEnd(pb(P_TX)),
            keys: true,
            values: false
        }

        for await (const [key] of this.db.iterator(options)) {
            const txid = b2h(key.slice(1))   // 64-char hex txid
            // binary-search convention: comparator(element, needle) returns
            // negative when element < needle (search to the right). The prior
            // form `needle.localeCompare(element_first16)` had the sign
            // INVERTED, and the result check `== -1` only matched the
            // not-found-at-insertion-index-0 case. Together this caused
            // ~half of all not-found needles to be misclassified as found
            // (returning -2 for insertion at index 1). Use `< 0` for any
            // not-found return and an element-vs-needle comparator.
            const txidIndex = bs(txidList, txid, function(element, needle) {
                return element.localeCompare(needle)
            })

            if (txidIndex < 0) {
                // Keep a stored tx the node no longer lists when told to keep.
                if (keepOnly) continue
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
