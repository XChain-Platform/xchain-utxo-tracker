/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 *
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided "AS IS", without warranties or conditions of any kind.
 *
 **********************************************************************
 *
 * XChain UTXO Tracker - FileManager Class
 *
 * This file handles reading and writing UTXO tracker data to LevelDB database
 *
 * Key/value encoding: all hashes stored as raw binary Buffers (not hex strings)
 * to minimize database size.
 *
 * Key layouts (byte sizes):
 *   B: [0x42][blockHash(32)]                                          = 33 B
 *   T: [0x54][txHash8(8)]                                             =  9 B
 *   I: [0x49][prevTxHash8(8)][outputIndex(4)]                        = 13 B
 *   O: [0x4F][scriptPubKey(32)][txHash8(8)][outputIndex(4)]          = 45 B
 *   H: [0x48][txHash8(8)][outputIndex(4)]                            = 13 B
 *   J: [0x4A][txHash8(8)][prevTxHash8(8)][outputIndex(4)]            = 21 B
 *   S: [0x53][scriptPubKey(32)]                                       = 33 B
 *   Z: [0x5A][blockHash(32)][scriptPubKey(32)]                        = 65 B
 *   K: [0x4B][blockHash(32)][scriptPubKey(32)][txHash8(8)][idx(4)]   = 77 B
 *   M: [0x4D][blockHash(32)][txHash8(8)][outputIndex(4)]             = 45 B
 *   N: [0x4E][blockHash(32)]                                          = 33 B
 *
 * Value layouts:
 *   B: [height(4)][timestamp(4)][previousHash(32)]                   = 40 B
 *   T: [blockHash(32)]                                                = 32 B
 *   I: [txHash8(8)]                                                   =  8 B
 *   O: [value(8)][height(4)][fullTxHash(32)]                         = 44 B
 *   H: [scriptPubKey(32)]                                             = 32 B
 *   S: [blockHash(32)][height(4)][txHash(32)]                        = 68 B
 *
 ********************************************************************/

// Load required libraries
const util = require('./util')

var levelup = require('levelup')
var leveldown = require('leveldown')
var memdown = require('memdown')
const encode = require('encoding-down')
const bs = require("binary-search")

// String-keyed entries (not binary, kept as-is)
const PREFIX_LAST_BLOCK_HEIGHT = "LAST_BLOCK_HEIGHT"
const PREFIX_LAST_BLOCK_HASH   = "LAST_BLOCK_HASH"

// Single-byte prefix values
const P_BLOCK      = 0x42  // 'B'
const P_TX         = 0x54  // 'T'
const P_INPUT      = 0x49  // 'I'
const P_OUTPUT     = 0x4F  // 'O'
const P_OUT_HINT   = 0x48  // 'H'
const P_IN_HINT    = 0x4A  // 'J'
const P_SCRIPT_BLK = 0x53  // 'S'
const P_BLK_SCRIPT = 0x5A  // 'Z'
const P_OUT_DEL    = 0x4B  // 'K'
const P_HINT_DEL   = 0x4D  // 'M'
const P_STORED_BLK = 0x4E  // 'N'

// ─── Binary helpers ───────────────────────────────────────────────────────────

function h2b(hex) { return Buffer.from(hex, 'hex') }
function b2h(buf) { return Buffer.isBuffer(buf) ? buf.toString('hex') : buf }
function pb(p)    { return Buffer.from([p]) }

function idxBuf(n) {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(n >>> 0, 0)
    return b
}

function rangeEnd(prefix) {
    return Buffer.concat([prefix, Buffer.alloc(12, 0xFF)])
}

// Normalize a key to a hex string for use as a JavaScript Map key.
// DB operations always use the original Buffer/string.
function toMapKey(key) {
    return Buffer.isBuffer(key) ? key.toString('hex') : key
}

// ─── Key constructors ─────────────────────────────────────────────────────────

function kBlock(blockHashHex) {
    return Buffer.concat([pb(P_BLOCK), h2b(blockHashHex)])
}
function kTx(txHash8Hex) {
    return Buffer.concat([pb(P_TX), h2b(txHash8Hex)])
}
function kInput(prevTxHash8Hex, idx) {
    return Buffer.concat([pb(P_INPUT), h2b(prevTxHash8Hex), idxBuf(idx)])
}
function kOutput(scriptHex, txHash8Hex, idx) {
    return Buffer.concat([pb(P_OUTPUT), h2b(scriptHex), h2b(txHash8Hex), idxBuf(idx)])
}
function kOutHint(txHash8Hex, idx) {
    return Buffer.concat([pb(P_OUT_HINT), h2b(txHash8Hex), idxBuf(idx)])
}
function kInHint(txHash8Hex, prevTxHash8Hex, idx) {
    return Buffer.concat([pb(P_IN_HINT), h2b(txHash8Hex), h2b(prevTxHash8Hex), idxBuf(idx)])
}
function kScriptBlk(scriptHex) {
    return Buffer.concat([pb(P_SCRIPT_BLK), h2b(scriptHex)])
}
function kBlkScript(blockHashHex, scriptHex) {
    return Buffer.concat([pb(P_BLK_SCRIPT), h2b(blockHashHex), h2b(scriptHex)])
}
function kOutDel(blockHashHex, scriptHex, txHash8Hex, idx) {
    return Buffer.concat([pb(P_OUT_DEL), h2b(blockHashHex), h2b(scriptHex), h2b(txHash8Hex), idxBuf(idx)])
}
function kHintDel(blockHashHex, txHash8Hex, idx) {
    return Buffer.concat([pb(P_HINT_DEL), h2b(blockHashHex), h2b(txHash8Hex), idxBuf(idx)])
}
function kStoredBlk(blockHashHex) {
    return Buffer.concat([pb(P_STORED_BLK), h2b(blockHashHex)])
}

// ─── Value encoders / decoders ────────────────────────────────────────────────

// B value: [height(4)][timestamp(4)][previousHash(32)] = 40 bytes
function encodeBlock(height, timestamp, previousHashHex) {
    const buf = Buffer.alloc(40)
    buf.writeUInt32BE(height, 0)
    buf.writeUInt32BE(timestamp, 4)
    h2b(previousHashHex).copy(buf, 8)
    return buf
}
function decodeBlock(buf) {
    return {
        h:  buf.readUInt32BE(0),
        t:  buf.readUInt32BE(4),
        ph: b2h(buf.slice(8, 40))
    }
}

// T value: [blockHash(32)] = 32 bytes
function encodeTx(blockHashHex) { return h2b(blockHashHex || ZERO_HASH) }
function decodeTx(buf)          { return { bh: b2h(buf.slice(0, 32)) } }

// I value: [txHash8(8)] = 8 bytes
function encodeInputVal(txHash8Hex) { return h2b(txHash8Hex) }
function decodeInputVal(buf)        { return { th: b2h(buf.slice(0, 8)) } }

// O value: [value(8)][height(4)][fullTxHash(32)] = 44 bytes
// height = -1 stored as 0xFFFFFFFF (twos-complement Int32)
const ZERO_HASH = '0'.repeat(64)
function encodeOutput(value, height, fullTxHashHex) {
    const buf = Buffer.alloc(44)
    buf.writeBigUInt64BE(BigInt(value), 0)
    buf.writeInt32BE(height != null ? height : -1, 8)
    if (fullTxHashHex) h2b(fullTxHashHex).copy(buf, 12)
    return buf
}
function decodeOutput(buf) {
    const fullTxHash = b2h(buf.slice(12, 44))
    return {
        v: buf.readBigUInt64BE(0).toString(),
        h: buf.readInt32BE(8),
        t: fullTxHash === ZERO_HASH ? null : fullTxHash
    }
}

// H value: [scriptPubKey(32)] = 32 bytes
function encodeOutHint(scriptHex) { return h2b(scriptHex) }

// S value: [blockHash(32)][height(4)][txHash(32)] = 68 bytes
function encodeScriptBlk(blockHashHex, height, txHashHex) {
    const buf = Buffer.alloc(68)
    h2b(blockHashHex).copy(buf, 0)
    buf.writeUInt32BE(height, 32)
    h2b(txHashHex).copy(buf, 36)
    return buf
}
function decodeScriptBlk(buf) {
    return {
        b:    b2h(buf.slice(0, 32)),
        h:    buf.readUInt32BE(32),
        txid: b2h(buf.slice(36, 68))
    }
}

const EMPTY = Buffer.alloc(0)

// ─── LevelUpStore class ───────────────────────────────────────────────────────

class LevelUpStore {
    constructor(dbName, inMemory = false) {
        this.dbName = dbName
        this.db = null
        this.transactionArray = new Map()
        this.deletedTransactionArray = new Map()
        this.inMemory = inMemory
    }

    async sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async close(){
        await this.db.close()
    }

    async createDatabase() {
        try {
            if (this.inMemory){
                this.db = levelup(memdown())
            } else {
                this.db = levelup(leveldown("/data/"+this.dbName))
            }
            return this.db
        } catch (err){
            throw new Error("Couldn't open/create levelup database")
        }
    }

    elementCompare(a,b){
        return (a < b ? -1: (a > b ? 1 : 0))
    }

    // Returns the stored value for a key currently pending in transactionArray.
    getTransactionValue(key){
        const item = this.transactionArray.get(toMapKey(key))
        return item != null ? item.value : null
    }

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
    }

    removeTransactionIfExists(key){
        const mapKey = toMapKey(key)
        if (this.transactionArray && this.transactionArray.has(mapKey)){
            return this.transactionArray.delete(mapKey)
        }
        return false
    }

    removeTransaction(key, deletedKey){
        const mapKey    = toMapKey(key)
        const delMapKey = toMapKey(deletedKey)

        if (!this.deletedTransactionArray.has(delMapKey)){
            this.deletedTransactionArray.set(delMapKey, new Map())
        }

        this.deletedTransactionArray.get(delMapKey).set(mapKey, this.transactionArray.get(mapKey).value)

        return this.transactionArray.delete(mapKey)
    }

    async beginTransaction(){
        this.transactionArray = new Map()
        this.deletedTransactionArray = new Map()
    }

    async endTransaction(batch=true){
        try {
            if (batch){
                let transactionArrayFromMap = Array.from(this.transactionArray.values())
                await this.db.batch(transactionArrayFromMap)
            }
            this.transactionArray = null
            this.deletedTransactionArray = null
        } catch (err){
            console.log("There were errors trying to insert data in a batch")
            console.log(err)
            throw new Error("Error in levelup batch inserting")
        }
    }

    // ─── Block height / hash ─────────────────────────────────────────────────

    async getLastBlockHeight(){
        try {
            let value = await this.db.get(PREFIX_LAST_BLOCK_HEIGHT)
            return parseInt(value.toString(), 16)
        } catch (err) {
            return -1
        }
    }

    async setLastBlockHeight(height){
        await this.addTransaction("put", PREFIX_LAST_BLOCK_HEIGHT, height.toString(16))
        return true
    }

    async getLastBlockHash(){
        try {
            return (await this.db.get(PREFIX_LAST_BLOCK_HASH)).toString()
        } catch (err) {
            return null
        }
    }

    async setLastBlockHash(hash){
        return await this.addTransaction("put", PREFIX_LAST_BLOCK_HASH, hash)
    }

    // ─── Stored block list (N prefix) ────────────────────────────────────────

    async addLastStoredBlock(blockHash){
        return await this.addTransaction("put", kStoredBlk(blockHash), EMPTY)
    }

    async removeLastStoredBlock(blockHash){
        const key = kStoredBlk(blockHash)
        if (this.removeTransactionIfExists(key)){
            return true
        }
        try {
            await this.addTransaction("del", key)
            return true
        } catch (err) {
            throw new Error("Error when trying to remove last stored block")
        }
    }

    // ─── Block (B prefix) ────────────────────────────────────────────────────

    async insertBlock(block) {
        return await this.addTransaction(
            "put",
            kBlock(block.hash),
            encodeBlock(block.height, block.timestamp, block.previousHash)
        )
    }

    async deleteBlock(blockHash) {
        return await this.addTransaction("del", kBlock(blockHash), null)
    }

    async getBlock(blockHash){
        try {
            const buf = await this.db.get(kBlock(blockHash))
            return decodeBlock(buf)
        } catch (err) {
            if (err.notFound) return null
            throw err
        }
    }

    // ─── Transaction (T prefix) ──────────────────────────────────────────────

    async insertTransaction(tx) {
        return await this.addTransaction(
            "put",
            kTx(tx.hash.substring(0, 16)),
            encodeTx(tx.blockHash)
        )
    }

    async deleteTransaction(txid) {
        return await this.addTransaction("del", kTx(txid.substring(0, 16)), null)
    }

    // Returns entries as { txid: "T"+txHash8Hex, block_hash: hex }
    // Caller strips the leading "T" with .substr(1) to get txHash8Hex.
    async getTransactions(txHashPrefix){
        return new Promise((resolve, reject) => {
            const transactions = []
            const prefix = Buffer.concat([pb(P_TX), h2b(txHashPrefix)])
            const options = {
                gte: prefix,
                lte: rangeEnd(prefix),
                keys: true,
                values: true
            }

            const stream = this.db.createReadStream(options)

            stream.on('data', function(data) {
                const txHash8Hex = b2h(data.key.slice(1))
                const blockHashHex = decodeTx(data.value).bh
                transactions.push({
                    txid: 'T' + txHash8Hex,
                    block_hash: blockHashHex
                })
            })

            stream.on('error', reject)
            stream.on('end', function() { resolve(transactions) })
        })
    }

    async getTransaction(txHashWithPrefix){
        // Accepts full key as hex string (prefix included) for backward compatibility
        try {
            return await this.db.get(h2b(txHashWithPrefix))
        } catch (err){
            if (err.notFound) return null
            throw err
        }
    }

    // ─── Input (I prefix) ────────────────────────────────────────────────────

    async insertInput(input) {
        return await this.addTransaction(
            "put",
            kInput(input.prevTxHash.substring(0, 16), input.prevOutputIndex),
            encodeInputVal(input.txHash)
        )
    }

    async getInput(txHash8, outputIndex){
        try {
            return await this.db.get(kInput(txHash8.substring(0, 16), outputIndex))
        } catch (err) {
            if (err.notFound) return null
            throw err
        }
    }

    async deleteInputs(txids){
        if (txids.length == 0) return 0

        const options = {
            gte: pb(P_INPUT),
            lte: rangeEnd(pb(P_INPUT)),
            keys: true,
            values: true,
        }

        const txids8 = txids.map(t => (Buffer.isBuffer(t) ? b2h(t) : t))
        const dbStream = this.db.createReadStream(options)
        let inputsCount = 0

        for await (const data of dbStream) {
            const txHash = decodeInputVal(data.value).th
            if (!txids8.includes(txHash)) {
                await this.addTransaction("del", data.key, null)
                inputsCount++
            }
        }

        return inputsCount
    }

    // ─── Input hint (J prefix) ───────────────────────────────────────────────

    async insertInputHint(input) {
        return await this.addTransaction(
            "put",
            kInHint(input.txHash, input.prevTxHash.substring(0, 16), input.prevOutputIndex),
            EMPTY
        )
    }

    async deleteInputsByHint(txid){
        const txHash8Hex = txid.substring(0, 16)
        const prefix = Buffer.concat([pb(P_IN_HINT), h2b(txHash8Hex)])

        const options = {
            gte: prefix,
            lte: rangeEnd(prefix),
            keys: true,
            values: true
        }

        let inputsCount = 0
        const dbStream = this.db.createReadStream(options)

        for await (const data of dbStream) {
            // J key layout: [J(1)][txHash8(8)][prevTxHash8(8)][outputIndex(4)]
            const prevTxHash8Buf = data.key.slice(9, 17)
            const idxBuf         = data.key.slice(17, 21)

            await this.addTransaction(
                "del",
                Buffer.concat([pb(P_INPUT), prevTxHash8Buf, idxBuf]),
                null
            )
            await this.addTransaction("del", data.key, null)
            inputsCount++
        }

        return inputsCount
    }

    async deleteInputsByHints(txids){
        let inputsDeleted = 0
        for (const txid of txids){
            inputsDeleted += await this.deleteInputsByHint(txid)
        }
        return inputsDeleted
    }

    // ─── Output (O prefix) ───────────────────────────────────────────────────

    async insertOutput(output) {
        return await this.addTransaction(
            "put",
            kOutput(output.scriptPubKey, output.txHash, output.outputIndex),
            encodeOutput(output.value, output.height, output.fullTxHash || null)
        )
    }

    // ─── Output hint (H prefix) ──────────────────────────────────────────────

    async insertOutputHint(output){
        return await this.addTransaction(
            "put",
            kOutHint(output.txHash, output.outputIndex),
            encodeOutHint(output.scriptPubKey)
        )
    }

    // ─── Output + hint removal (REMOVE_SPENT path) ───────────────────────────

    async removeOutputWithInput(input) {
        const hKey = kOutHint(input.prevTxHash, input.prevOutputIndex)
        const mKey = kHintDel(input.blockHash, input.prevTxHash, input.prevOutputIndex)

        let scriptPubKeyBuf = null
        let oVal = null
        let oKey = null

        try {
            scriptPubKeyBuf = await this.db.get(hKey)                               // 32-byte Buffer
            oKey = Buffer.concat([pb(P_OUTPUT), scriptPubKeyBuf,
                                  h2b(input.prevTxHash), idxBuf(input.prevOutputIndex)])
            oVal = await this.db.get(oKey)
        } catch (err) {
            // Output not yet committed — check in-memory transaction map
            const inMemScript = this.getTransactionValue(hKey)
            if (inMemScript != null){
                const inMemOKey = Buffer.concat([pb(P_OUTPUT), inMemScript,
                                                 h2b(input.prevTxHash), idxBuf(input.prevOutputIndex)])
                if (!this.removeTransaction(inMemOKey, input.blockHash)){
                    throw Error("Missing output match for input "+JSON.stringify(input))
                }
                if (!this.removeTransaction(hKey, input.blockHash)){
                    throw Error("Missing outputHintKey match for input "+JSON.stringify(input))
                }
            } else {
                console.log("Warning: Missing outputHintKey for input "+JSON.stringify(input)+" - output may have been indexed before REMOVE_SPENT was enabled")
            }
            return true
        }

        const kKey = Buffer.concat([pb(P_OUT_DEL), h2b(input.blockHash), scriptPubKeyBuf,
                                    h2b(input.prevTxHash), idxBuf(input.prevOutputIndex)])

        // Stage for deferred deletion — will be purged after batch commit
        await this.addTransaction("put", mKey, scriptPubKeyBuf)
        await this.addTransaction("put", kKey, oVal)
        await this.addTransaction("del", oKey)
        await this.addTransaction("del", hKey)
        return true
    }

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
        const dbStream = this.db.createReadStream(options)

        for await (const data of dbStream) {
            // H key layout: [H(1)][txHash8(8)][outputIndex(4)]
            const idxPart = data.key.slice(9, 13)   // 4-byte output index
            const scriptPubKeyBuf = data.value       // 32-byte Buffer

            const oKey = Buffer.concat([pb(P_OUTPUT), scriptPubKeyBuf, txHash8Buf, idxPart])
            await this.addTransaction("del", oKey, null)
            await this.addTransaction("del", data.key, null)
            outputsCount++
        }

        return outputsCount
    }

    async deleteOutputsByHints(txids){
        let outputsDeleted = 0
        for (const txid of txids){
            outputsDeleted += await this.deleteOutputsByHint(txid)
        }
        return outputsDeleted
    }

    // ─── Deleted output recovery (K / M prefix) ──────────────────────────────

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
                        // Re-create put entry — key is hex-encoded Buffer
                        const keyBuf = Buffer.isBuffer(mapKey) ? mapKey : h2b(mapKey)
                        this.transactionArray.set(mapKey, { type: "put", key: keyBuf, value })
                    }
                })
            }
            this.deletedTransactionArray.delete(delMapKey)
        }

        await this.processDeletedOutputsInDb(blockHash, recover, false)
        await this.processDeletedOutputsInDb(blockHash, recover, true)
    }

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

        const stream = this.db.createReadStream(options)

        for await (const data of stream) {
            if (recover){
                // Strip the prefix+blockHash to get the original key suffix,
                // then prepend the correct single-byte prefix to reconstruct it.
                const suffix = data.key.slice(33)  // skip [prefix(1)][blockHash(32)]
                const restorePrefix = processOutputHints ? P_OUT_HINT : P_OUTPUT
                const restoreKey = Buffer.concat([pb(restorePrefix), suffix])
                await this.addTransaction("put", restoreKey, data.value)
            }

            await this.addTransaction("del", data.key)
        }
    }

    async recoverDeletedOutputsHints(blockHash){
        const prefixBuf = Buffer.concat([pb(P_HINT_DEL), h2b(blockHash)])

        const options = {
            gte: prefixBuf,
            lte: rangeEnd(prefixBuf),
            keys: true,
            values: true
        }

        const stream = this.db.createReadStream(options)

        for await (const data of stream) {
            const suffix  = data.key.slice(33)  // skip [M(1)][blockHash(32)]
            const hKey = Buffer.concat([pb(P_OUT_HINT), suffix])
            await this.addTransaction("put", hKey, data.value)
            await this.addTransaction("del", data.key)
        }
    }

    // ─── Output script block (S / Z prefix) ──────────────────────────────────

    async insertOutputScriptBlock(outputScript, blockHash, txHash, blockHeight){
        // Mempool transactions have no confirmed block — S/Z prefix tracking is meaningless
        if (!blockHash) return true

        const sKey = kScriptBlk(outputScript)

        // Check the in-memory batch first — avoids a real LevelDB read for any
        // script already staged in the current 500-block batch window
        if (this.getTransactionValue(sKey) !== null) {
            return true
        }

        try {
            await this.db.get(sKey)
            return true  // already exists
        } catch (err) {
            if (!err.notFound) throw err
        }

        await this.addTransaction("put", sKey,
            encodeScriptBlk(blockHash, blockHeight, txHash))
        await this.addTransaction("put", kBlkScript(blockHash, outputScript), EMPTY)

        return true
    }

    async getOutputScriptBlock(outputScript){
        try {
            const buf = await this.db.get(kScriptBlk(outputScript))
            return decodeScriptBlk(buf)
        } catch (err) {
            if (err.notFound) return null
            throw err
        }
    }

    async removeOutputScriptsInBlock(blockHash){
        const prefixBuf = Buffer.concat([pb(P_BLK_SCRIPT), h2b(blockHash)])

        const options = {
            gte: prefixBuf,
            lte: rangeEnd(prefixBuf),
            keys: true,
            values: true
        }

        const stream = this.db.createReadStream(options)

        for await (const data of stream) {
            // Z key: [Z(1)][blockHash(32)][scriptPubKey(32)]
            const scriptBuf = data.key.slice(33)
            await this.addTransaction("del", Buffer.concat([pb(P_SCRIPT_BLK), scriptBuf]))
            await this.addTransaction("del", data.key)
        }
    }

    // ─── Queries ─────────────────────────────────────────────────────────────

    async getOutputsScriptPubKey(scriptPubKey){
        return new Promise((resolve, reject) => {
            const outputs = []
            const prefix  = Buffer.concat([pb(P_OUTPUT), h2b(scriptPubKey)])
            const options = {
                gte: prefix,
                lte: rangeEnd(prefix),
                keys: true,
                values: true
            }

            const stream = this.db.createReadStream(options)

            stream.on('data', function(data) {
                // O key: [O(1)][scriptPubKey(32)][txHash8(8)][outputIndex(4)]
                const txHash8Hex = b2h(data.key.slice(33, 41))
                const n          = data.key.readUInt32BE(41)
                const decoded    = decodeOutput(data.value)

                outputs.push({
                    txid:     txHash8Hex,
                    fullTxid: decoded.t || null,
                    vout:     n,
                    value:    decoded.v,
                    height:   decoded.h
                })
            })

            stream.on('error', reject)
            stream.on('end', function() { resolve(outputs) })
        })
    }

    async getLastBlock(){
        return new Promise((resolve, reject) => {
            const options = {
                gte: pb(P_BLOCK),
                lte: rangeEnd(pb(P_BLOCK)),
                keys: true,
                values: true
            }

            let maxBlockHeight = null
            let maxBlockObj    = null
            const stream = this.db.createReadStream(options)

            stream.on('data', function(data) {
                const blockHash = b2h(data.key.slice(1))
                const decoded   = decodeBlock(data.value)

                if (maxBlockHeight === null || decoded.h > maxBlockHeight){
                    maxBlockHeight = decoded.h
                    maxBlockObj = {
                        hash:         blockHash,
                        height:       decoded.h,
                        timestamp:    decoded.t,
                        previousHash: decoded.ph
                    }
                }
            })

            stream.on('error', reject)
            stream.on('end', function() { resolve(maxBlockObj) })
        })
    }

    async getLastStoredBlocks(){
        return new Promise((resolve, reject) => {
            const result  = []
            const options = {
                gte: pb(P_STORED_BLK),
                lte: rangeEnd(pb(P_STORED_BLK)),
                keys: true,
                values: true
            }

            const stream = this.db.createReadStream(options)

            stream.on('data', function(data) {
                result.push(b2h(data.key.slice(1)))
            })

            stream.on('error', reject)
            stream.on('end', function() { resolve(result) })
        })
    }

    // ─── Mempool helpers ─────────────────────────────────────────────────────

    async deleteAndCompareTxsNotInList(txidList){
        const deletedTxs = []
        const options = {
            gte: pb(P_TX),
            lte: rangeEnd(pb(P_TX)),
            keys: true
        }

        const dbStream = this.db.createReadStream(options)

        for await (const data of dbStream) {
            const txid = b2h(data.key.slice(1))   // 16-char hex (txHash8)
            const txidIndex = bs(txidList, txid, function(element, needle) {
                return needle.localeCompare(element.substring(0, 16))
            })

            if (txidIndex == -1) {
                await this.deleteTransaction(txid)
                deletedTxs.push(txid)
            } else {
                txidList.splice(txidIndex, 1)
            }
        }

        const outputsDeleted = await this.deleteOutputsByHints(deletedTxs)
        const inputsDeleted  = await this.deleteInputsByHints(deletedTxs)

        return { transactionsDeleted: deletedTxs.length, outputsDeleted, inputsDeleted }
    }

    // ─── Generic key-pattern scan (used by API) ───────────────────────────────
    // pattern: hex string representing the binary key prefix

    async getValuesFromKeyPattern(pattern){
        return new Promise((resolve, reject) => {
            const patternBuf = Buffer.isBuffer(pattern) ? pattern : h2b(pattern)
            const values = []
            const options = {
                gte: patternBuf,
                lte: rangeEnd(patternBuf),
                keys: true,
                values: true
            }

            const stream = this.db.createReadStream(options)

            stream.on('data', function(data) {
                values.push({
                    key:   b2h(data.key),
                    value: b2h(data.value)
                })
            })

            stream.on('error', function(err) {
                console.log("Error getting values from patterns")
                console.log(err)
                reject(err)
            })

            stream.on('end', function() { resolve(values) })
        })
    }
}

module.exports = LevelUpStore
