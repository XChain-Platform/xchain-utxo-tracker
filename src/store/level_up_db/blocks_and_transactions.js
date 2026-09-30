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
const { P_TX, P_OUT_BLK, ZERO_HASH } = require('./constants')
const { toMapKey, kBlock, kTx, h2b, b2h, pb, rangeEnd } = require('./key_codec')
const { encodeBlock, decodeBlock, encodeTx, decodeTx } = require('./value_codec')

const TXID_HEX_RE = /^[0-9a-f]{64}$/

// Two private key families backing the exact full-txid index, kept local to
// this file (not registered in key_codec.js/constants.js) since the T
// keyspace's 8-byte prefix is shared by every other T consumer and cannot be
// widened without touching them. 0x58 ('X') and 0x59 ('Y') are unused by every
// k* family declared in level_up_db.js's schema doc.
//
// X: full-txid -> blockHash. Keyed on the whole 32-byte txid, so two txids
// that share their 8-byte T-prefix never contend for the same slot the way T
// itself does; this is what makes coexistence and rollback symmetry possible.
const P_TX_EXACT = 0x58

function kTxExact(txidHex) {
    if (txidHex.length !== 64) {
        throw new Error(`kTxExact expects a 64-hex (32-byte) txid, got ${txidHex.length} chars`)
    }
    const buf = Buffer.allocUnsafe(33)
    buf[0] = P_TX_EXACT
    buf.write(txidHex, 1, 'hex')
    return buf
}

// Y: (blockHash, txHash8) -> full txid. Recovers exactly which txid a given
// block created under a given 8-byte prefix, so a rollback can target that
// tx's own X (and, if still current, T) record even after a later colliding
// tx has overwritten the shared T slot. Scoped per-block (not just per
// prefix) because the T slot's occupant can change out from under it.
const P_TX_BLOCK_RECOVERY = 0x59

function kTxBlockRecovery(blockHashHex, txHash8Hex) {
    if (blockHashHex.length !== 64) {
        throw new Error(`kTxBlockRecovery expects a 64-hex (32-byte) blockHash, got ${blockHashHex.length} chars`)
    }
    if (txHash8Hex.length !== 16) {
        throw new Error(`kTxBlockRecovery expects a 16-hex (8-byte) txid prefix, got ${txHash8Hex.length} chars`)
    }
    const buf = Buffer.allocUnsafe(41)
    buf[0] = P_TX_BLOCK_RECOVERY
    buf.write(blockHashHex, 1, 'hex')
    buf.write(txHash8Hex, 33, 'hex')
    return buf
}

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

    // T value: [blockHash(32)][fullTxid(32)] = 64 bytes. Kept for
    // getTransactions/getTransaction and mempool tracking, which only ever
    // need the 8-byte prefix; it stays a single slot per prefix and can be
    // silently overwritten by a later colliding txid, same as before. The
    // exact-match reader (getTxBlock) does not use it: it reads the X record
    // below instead, which is collision-free because it is keyed on the full
    // txid rather than an 8-byte prefix. The Y record lets a later rollback
    // recover which exact txid this block indexed under a given prefix, even
    // after a colliding tx has overwritten the T/X slot (see
    // deleteTransactionsInBlock). Records written before the X/Y fields
    // existed are the legacy T-only shape; getTxBlock treats those as
    // unindexed since there is no X record to find (see README.md's
    // Upgrading section for the re-index path).
    async insertTransaction(tx) {
        const txHash8 = tx.hash.substring(0, 16)
        const blockHash = tx.blockHash || ZERO_HASH
        await this.addTransaction(
            "put",
            kTx(txHash8),
            Buffer.concat([encodeTx(tx.blockHash), h2b(tx.hash)])
        )
        await this.addTransaction("put", kTxExact(tx.hash), encodeTx(tx.blockHash))
        return await this.addTransaction("put", kTxBlockRecovery(blockHash, txHash8), h2b(tx.hash))
    },

    // Deletes the T slot for an 8-byte prefix with no per-block context (mempool
    // cleanup and mempool-eviction diffing, neither of which knows a blockHash).
    // Best-effort on the X record: only cleaned up here when the caller happens
    // to pass the full txid (mempool confirmation cleanup does); the ambiguous
    // 8-byte-only callers leave any X record for a rolled-back or evicted
    // mempool entry to be masked by getTxBlock's own getBlock() check rather
    // than actively removed. deleteTransactionsInBlock (the confirmed-chain
    // rollback path) does not call this: it uses the Y record instead so a
    // collision cannot make it delete the wrong tx's data.
    async deleteTransaction(txid) {
        if (typeof txid === 'string' && txid.length === 64) {
            await this.addTransaction("del", kTxExact(txid.toLowerCase()), null)
        }
        return await this.addTransaction("del", kTx(txid.substring(0, 16)), null)
    },

    // Deletes the T (exact txid->block) records for every transaction created
    // in blockHash, via the W creation-block reverse index (every transaction
    // has at least one output, so its txHash8 always appears there). Called
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

        const seenTxHash8 = new Set()
        for await (const [key] of this.db.iterator(options)) {
            // W key: [W(1)][blockHash(32)][txHash8(8)][outputIndex(4)]
            const txHash8Hex = b2h(key.slice(33, 41))
            if (seenTxHash8.has(txHash8Hex)) continue
            seenTxHash8.add(txHash8Hex)
            await this.deleteTxBlockRecord(txHash8Hex, blockHash)
        }

        return seenTxHash8.size
    },

    // Reverses exactly what insertTransaction wrote for this (blockHash,
    // txHash8) pair. Uses the Y record to recover the txid this block
    // actually indexed under txHash8Hex, so a collision where a later block's
    // tx has since taken over the shared T/X slot does not make this delete
    // that other, still-live tx's data. Falls back to the pre-Y-record blind
    // T delete for history indexed before this record existed (see README.md's
    // Upgrading section).
    async deleteTxBlockRecord(txHash8Hex, blockHash) {
        const recoveryKey = kTxBlockRecovery(blockHash, txHash8Hex)
        const recoveredTxid = await this.db.get(recoveryKey)

        if (recoveredTxid === undefined) {
            return await this.deleteTransaction(txHash8Hex)
        }

        const fullTxid = b2h(recoveredTxid)

        // Only clear the T slot if it still belongs to this exact tx: a later
        // colliding tx sharing this 8-byte prefix may have since overwritten
        // it, and that tx has not itself been rolled back.
        const tValue = await this.db.get(kTx(txHash8Hex))
        if (tValue !== undefined && tValue.length >= 64 && b2h(tValue.slice(32, 64)) === fullTxid) {
            await this.addTransaction("del", kTx(txHash8Hex), null)
        }

        await this.addTransaction("del", kTxExact(fullTxid), null)
        return await this.addTransaction("del", recoveryKey, null)
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
