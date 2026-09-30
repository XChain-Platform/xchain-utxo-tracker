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

const config = require('../../config')
const memoryBudget = require('../memory_budget')
const { ClassicLevel } = require('classic-level')
const { MemoryLevel } = require('memory-level')
const { DEBUG_TRACE, logger, PREFIX_LAST_BLOCK_HEIGHT, PREFIX_LAST_BLOCK_HASH, EMPTY, P_BLOCK, P_STORED_BLK } = require('./constants')
const { kStoredBlk, b2h, pb, rangeEnd } = require('./key_codec')
const { decodeBlock } = require('./value_codec')
const LevelUpStore = require('../level_up_db.js')

module.exports = {
    async sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    },

    async close(){
        await this.db.close()
    },

    // dataDir overrides the on-disk store's directory (defaults to "/data/"+dbName)
    // and, when given, forces the ClassicLevel branch even if inMemory is set: this
    // is the one seam the on-disk test hook uses, so it exercises this exact open
    // path (resetCaches, cache/write-buffer sizing, error wrapping) instead of a
    // hand-rolled substitute that happens to also use ClassicLevel.
    async createDatabase(dataDir) {
        // Open time is the one moment a store is guaranteed to have no batch in flight,
        // which is why the reset lives here and not in the constructor: an in-flight
        // batch's staged outputs are in outputCache but not yet on disk, so clearing it
        // mid-batch would turn a Phase 2 cache hit into a DB miss. Every production
        // caller (tracker start, mempool store, api.js isDbEmpty, which runs to
        // completion before startApi launches the tracker) opens cold.
        LevelUpStore.resetCaches()
        try {
            if (this.inMemory && !dataDir){
                this.db = new MemoryLevel({ keyEncoding: 'buffer', valueEncoding: 'buffer' })
            } else {
                // A large block cache keeps hot UTXO index blocks resident: on big
                // mainnet DBs on spinning disks, the 8 MB default turns every cold
                // lookup into a random seek. Sized by memoryBudget against what this
                // process may use; LEVELDB_CACHE_BYTES overrides outright.
                this.db = new ClassicLevel(dataDir || ("/data/"+this.dbName), { keyEncoding: 'buffer', valueEncoding: 'buffer',
                    cacheSize: memoryBudget.leveldbCacheBytes(),
                    writeBufferSize: config.LEVELDB_WRITE_BUFFER_BYTES,
                    maxOpenFiles: config.LEVELDB_MAX_OPEN_FILES,
                    maxFileSize: config.LEVELDB_MAX_FILE_SIZE_BYTES })
            }
            // abstract-level opens lazily on first op; open explicitly so any
            // open/create error surfaces here rather than on the first read.
            await this.db.open()
            return this.db
        } catch (err){
            throw new Error("Couldn't open/create LevelDB '" + this.dbName + "': " + (err && err.message), { cause: err })
        }
    },

    elementCompare(a,b){
        return (a < b ? -1: (a > b ? 1 : 0))
    },

    async beginTransaction(){
        this.transactionArray = new Map()
        this.deletedTransactionArray = new Map()
    },

    async endTransaction(batch=true){
        try {
            if (!batch){
                // Discarding an in-flight batch (reorg rollback / mid-batch reorg).
                // insertOutputScriptBlock adds a script to the static knownScripts
                // existence cache as soon as it STAGES the S/Z puts, before they
                // reach disk. When the batch is discarded those puts never commit,
                // so a stale knownScripts entry would make the replacement chain's
                // re-mined output Tier-0 hit and skip re-writing S/Z, permanently
                // losing that script's first-seen height. Reset here (mirrors the
                // reorg-path reset in removeOutputScriptsInBlock): the cache is a
                // pure read-accelerator rebuilt from disk, so a reset is always safe.
                LevelUpStore.knownScripts = new Set()
            }
            if (batch){
                let transactionArrayFromMap = Array.from(this.transactionArray.values())
                if (DEBUG_TRACE) {
                    let puts = 0, dels = 0, oPut = 0, oDel = 0
                    for (const item of transactionArrayFromMap) {
                        if (item.type === 'put') puts++; else if (item.type === 'del') dels++
                        // O-prefix is 0x4F; first byte of binary key tells us which prefix
                        if (Buffer.isBuffer(item.key) && item.key[0] === 0x4F) {
                            if (item.type === 'put') oPut++; else if (item.type === 'del') oDel++
                        }
                    }
                    logger.info(`TRACE endTransaction db=${this.dbName} total=${transactionArrayFromMap.length} puts=${puts} dels=${dels} oPuts=${oPut} oDels=${oDel}`)
                }
                await this.db.batch(transactionArrayFromMap)
            }
            this.transactionArray = null
            this.deletedTransactionArray = null
        } catch (err){
            logger.info("There were errors trying to insert data in a batch")
            logger.info(err)
            // Carry the LevelDB error, not just a label. This is the atomic flush of a
            // whole block batch, and the throw reaches the polling loop's top-level
            // guard, verifyReorg's retry classifier and the supervisor log; without the
            // cause those readers see a constant string and the real code/message only
            // exists in an earlier console line nobody correlates. Same convention as
            // createDatabase and removeLastStoredBlock in this file. The leading text is
            // kept verbatim as the stable prefix callers and tests match on.
            throw new Error("Error in LevelDB batch inserting: " + (err && err.message), { cause: err })
        }
    },

    // Block height / hash

    async getLastBlockHeight(){
        const value = await this.db.get(PREFIX_LAST_BLOCK_HEIGHT)
        if (value === undefined) return -1
        return parseInt(value.toString(), 16)
    },

    // Records the block-tip in the same in-flight batch as the UTXO inserts
    // produced while processing this block. Because endTransaction() flushes
    // the whole batch atomically via db.batch(), the on-disk last-block-height
    // and all of the block's outputs become queryable together, never out of
    // order. This is the load-bearing guarantee that get_sync_status and
    // is_quiescent rely on: callers can treat a returned committed_height as
    // "every output in blocks 0..N is immediately queryable".
    async setLastBlockHeight(height){
        // valueEncoding is 'buffer': store the hex string as its UTF-8 bytes.
        await this.addTransaction("put", PREFIX_LAST_BLOCK_HEIGHT, Buffer.from(height.toString(16)))
        return true
    },

    async getLastBlockHash(){
        const value = await this.db.get(PREFIX_LAST_BLOCK_HASH)
        if (value === undefined) return null
        return value.toString()
    },

    async setLastBlockHash(hash){
        // valueEncoding is 'buffer': store the hash string as its UTF-8 bytes.
        return await this.addTransaction("put", PREFIX_LAST_BLOCK_HASH, Buffer.from(hash))
    },

    // Stored block list (N prefix)

    async addLastStoredBlock(blockHash){
        return await this.addTransaction("put", kStoredBlk(blockHash), EMPTY)
    },

    async removeLastStoredBlock(blockHash){
        const key = kStoredBlk(blockHash)
        if (this.removeTransactionIfExists(key)){
            return true
        }
        try {
            await this.addTransaction("del", key)
            return true
        } catch (err) {
            throw new Error("removeLastStoredBlock failed for " + blockHash + ": " + (err && err.message), { cause: err })
        }
    },

    async getLastBlock(){
        const options = {
            gte: pb(P_BLOCK),
            lte: rangeEnd(pb(P_BLOCK)),
            keys: true,
            values: true
        }

        let maxBlockHeight = null
        let maxBlockObj    = null

        for await (const [key, value] of this.db.iterator(options)) {
            const blockHash = b2h(key.slice(1))
            const decoded   = decodeBlock(value)

            if (maxBlockHeight === null || decoded.h > maxBlockHeight){
                maxBlockHeight = decoded.h
                maxBlockObj = {
                    hash:         blockHash,
                    height:       decoded.h,
                    timestamp:    decoded.t,
                    previousHash: decoded.ph
                }
            }
        }

        return maxBlockObj
    },

    async getLastStoredBlocks(){
        const result  = []
        const options = {
            gte: pb(P_STORED_BLK),
            lte: rangeEnd(pb(P_STORED_BLK)),
            keys: true,
            values: false
        }

        for await (const [key] of this.db.iterator(options)) {
            result.push(b2h(key.slice(1)))
        }

        return result
    },
}
