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
 *   S: [height(4)]                                                    =  4 B
 *
 ********************************************************************/

// Load required libraries
const util = require('./util')

var levelup = require('levelup')
var leveldown = require('rocksdb')
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
    return Buffer.concat([prefix, Buffer.from([0xFF])])
}

// Normalize a key to a string for use as a JavaScript Map key.
// DB operations always use the original Buffer/string.
//
// Uses 'latin1' instead of 'hex': each byte maps to one char (vs 2 for hex),
// and the conversion is a plain byte-reinterpret rather than nibble-to-char,
// so both the allocation size and encoding cost are roughly halved. V8
// internalizes these the same way it internalizes hex strings.
function toMapKey(key) {
    return Buffer.isBuffer(key) ? key.toString('latin1') : key
}

// ─── Key constructors ─────────────────────────────────────────────────────────
// Each constructor allocates a single Buffer and writes fields directly via
// buf.write(hex, offset, 'hex') — avoids the 3–5 temporary Buffers that
// Buffer.concat + h2b + pb + idxBuf produced previously. At ~5M key builds per
// batch flush this is the largest single contributor to GC pressure.

function kBlock(blockHashHex) {
    const buf = Buffer.allocUnsafe(33)
    buf[0] = P_BLOCK
    buf.write(blockHashHex, 1, 'hex')
    return buf
}
function kTx(txHash8Hex) {
    const buf = Buffer.allocUnsafe(9)
    buf[0] = P_TX
    buf.write(txHash8Hex, 1, 'hex')
    return buf
}
function kInput(prevTxHash8Hex, idx) {
    const buf = Buffer.allocUnsafe(13)
    buf[0] = P_INPUT
    buf.write(prevTxHash8Hex, 1, 'hex')
    buf.writeUInt32BE(idx >>> 0, 9)
    return buf
}
function kOutput(scriptHex, txHash8Hex, idx) {
    const buf = Buffer.allocUnsafe(45)
    buf[0] = P_OUTPUT
    buf.write(scriptHex, 1, 'hex')
    buf.write(txHash8Hex, 33, 'hex')
    buf.writeUInt32BE(idx >>> 0, 41)
    return buf
}
function kOutHint(txHash8Hex, idx) {
    const buf = Buffer.allocUnsafe(13)
    buf[0] = P_OUT_HINT
    buf.write(txHash8Hex, 1, 'hex')
    buf.writeUInt32BE(idx >>> 0, 9)
    return buf
}
function kInHint(txHash8Hex, prevTxHash8Hex, idx) {
    const buf = Buffer.allocUnsafe(21)
    buf[0] = P_IN_HINT
    buf.write(txHash8Hex, 1, 'hex')
    buf.write(prevTxHash8Hex, 9, 'hex')
    buf.writeUInt32BE(idx >>> 0, 17)
    return buf
}
function kScriptBlk(scriptHex) {
    const buf = Buffer.allocUnsafe(33)
    buf[0] = P_SCRIPT_BLK
    buf.write(scriptHex, 1, 'hex')
    return buf
}
function kScriptBlkFromBuf(scriptBuf) {
    const buf = Buffer.allocUnsafe(33)
    buf[0] = P_SCRIPT_BLK
    scriptBuf.copy(buf, 1, 0, 32)
    return buf
}
function kBlkScript(blockHashHex, scriptHex) {
    const buf = Buffer.allocUnsafe(65)
    buf[0] = P_BLK_SCRIPT
    buf.write(blockHashHex, 1, 'hex')
    buf.write(scriptHex, 33, 'hex')
    return buf
}
function kBlkScriptFromBuf(blockHashHex, scriptBuf) {
    const buf = Buffer.allocUnsafe(65)
    buf[0] = P_BLK_SCRIPT
    buf.write(blockHashHex, 1, 'hex')
    scriptBuf.copy(buf, 33, 0, 32)
    return buf
}
function kOutDel(blockHashHex, scriptHex, txHash8Hex, idx) {
    const buf = Buffer.allocUnsafe(77)
    buf[0] = P_OUT_DEL
    buf.write(blockHashHex, 1, 'hex')
    buf.write(scriptHex, 33, 'hex')
    buf.write(txHash8Hex, 65, 'hex')
    buf.writeUInt32BE(idx >>> 0, 73)
    return buf
}
function kHintDel(blockHashHex, txHash8Hex, idx) {
    const buf = Buffer.allocUnsafe(45)
    buf[0] = P_HINT_DEL
    buf.write(blockHashHex, 1, 'hex')
    buf.write(txHash8Hex, 33, 'hex')
    buf.writeUInt32BE(idx >>> 0, 41)
    return buf
}
function kStoredBlk(blockHashHex) {
    const buf = Buffer.allocUnsafe(33)
    buf[0] = P_STORED_BLK
    buf.write(blockHashHex, 1, 'hex')
    return buf
}
// Build an O-prefixed output key from an already-binary scriptPubKey buffer
// (used in the input-removal path where the script is fetched from the H index).
function kOutputFromBuf(scriptPubKeyBuf, txHash8Hex, idx) {
    const buf = Buffer.allocUnsafe(45)
    buf[0] = P_OUTPUT
    scriptPubKeyBuf.copy(buf, 1, 0, 32)
    buf.write(txHash8Hex, 33, 'hex')
    buf.writeUInt32BE(idx >>> 0, 41)
    return buf
}
// Build a K-prefixed deleted-output key from a binary scriptPubKey buffer.
function kOutDelFromBuf(blockHashHex, scriptPubKeyBuf, txHash8Hex, idx) {
    const buf = Buffer.allocUnsafe(77)
    buf[0] = P_OUT_DEL
    buf.write(blockHashHex, 1, 'hex')
    scriptPubKeyBuf.copy(buf, 33, 0, 32)
    buf.write(txHash8Hex, 65, 'hex')
    buf.writeUInt32BE(idx >>> 0, 73)
    return buf
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

// S value: [height(4)] = 4 bytes
function encodeScriptBlk(height) {
    const buf = Buffer.alloc(4)
    buf.writeUInt32BE(height, 0)
    return buf
}
function decodeScriptBlk(buf) {
    return { h: buf.readUInt32BE(0) }
}

const EMPTY = Buffer.alloc(0)

// ─── LevelUpStore class ───────────────────────────────────────────────────────

// LRU-ish cache for recently-written output values, keyed by `${txHash8}:${idx}`.
// UTXO locality: most spends consume outputs created within the last few thousand
// blocks, so a bounded in-memory cache absorbs a large fraction of Phase 2 reads
// in removeOutputsWithInputsBatch without touching the DB. Map insertion order
// gives FIFO eviction; entries are also evicted on spend.
const OUTPUT_CACHE_MAX = 2_000_000

const KNOWN_SCRIPTS_MAX = 2_000_000

class LevelUpStore {
    static parseInBuckets = { hintRead: 0, outRead: 0, stage: 0 }
    static outputCache = new Map()
    static outputCacheHits = 0
    static outputCacheMisses = 0
    static knownScripts = new Set()
    static knownScriptsHits = 0
    static knownScriptsMisses = 0

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
                this.db = levelup(leveldown("/data/"+this.dbName, {
                    maxBackgroundCompactions: 1,
                    maxBackgroundFlushes: 1
                }))
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
            return await this.db.get(kInput(txHash8, outputIndex))
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

    // output.scriptPubKey may be a Buffer (hot path) or a hex string (mempool / legacy callers).
    async insertOutput(output) {
        const oVal = encodeOutput(output.value, output.height, output.fullTxHash || null)

        // Populate the recent-output cache so Phase 2 of removeOutputsWithInputsBatch
        // can absorb spends of this output without a DB read.
        // Pack outputIndex into 2 BMP chars (high/low 16 bits) instead of
        // ":" + String(n) — avoids the NumberPrototypeToString hot spot from the
        // profile while covering the full 32-bit range.
        const _oi = output.outputIndex
        const cacheKey = output.txHash + String.fromCharCode((_oi >>> 16) & 0xFFFF, _oi & 0xFFFF)
        const cache = LevelUpStore.outputCache
        cache.set(cacheKey, oVal)
        if (cache.size > OUTPUT_CACHE_MAX) {
            // Recreate the Map to avoid V8 tombstone accumulation from
            // constant add+delete patterns, which causes steady degradation.
            LevelUpStore.outputCache = new Map()
        }

        const oKey = Buffer.isBuffer(output.scriptPubKey)
            ? kOutputFromBuf(output.scriptPubKey, output.txHash, output.outputIndex)
            : kOutput(output.scriptPubKey, output.txHash, output.outputIndex)
        return await this.addTransaction("put", oKey, oVal)
    }

    // ─── Output hint (H prefix) ──────────────────────────────────────────────

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
            oKey = kOutputFromBuf(scriptPubKeyBuf, input.prevTxHash, input.prevOutputIndex)
            oVal = await this.db.get(oKey)
        } catch (err) {
            // Output not yet committed — check in-memory transaction map
            const inMemScript = this.getTransactionValue(hKey)
            if (inMemScript != null){
                const inMemOKey = kOutputFromBuf(inMemScript, input.prevTxHash, input.prevOutputIndex)
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

        const kKey = kOutDelFromBuf(input.blockHash, scriptPubKeyBuf, input.prevTxHash, input.prevOutputIndex)

        // Stage for deferred deletion — will be purged after batch commit
        await this.addTransaction("put", mKey, scriptPubKeyBuf)
        await this.addTransaction("put", kKey, oVal)
        await this.addTransaction("del", oKey)
        await this.addTransaction("del", hKey)
        return true
    }

    // Batch version of removeOutputWithInput — collects all inputs for a block,
    // resolves hints and outputs with 2 getMany calls instead of N individual db.get().
    async removeOutputsWithInputsBatch(inputs) {
        if (inputs.length === 0) return 0

        const resolved = new Array(inputs.length)
        const hintDbKeys = []
        const hintDbIndices = []

        // ── Phase 1: Resolve all hint keys (scriptPubKey lookup) ──
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
                    console.log("Warning: Missing outputHintKey for input " + JSON.stringify(inputs[i]) + " - output may have been indexed before REMOVE_SPENT was enabled")
                    resolved[i] = null
                    continue
                }
                resolved[i].scriptPubKeyBuf = hintValues[j]
            }
        }
        LevelUpStore.parseInBuckets.hintRead += Date.now() - _tHint

        // ── Phase 2: Resolve all output values ──
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

            // Cache lookup — must match the fromCharCode encoding used in insertOutput
            const _pi = inp.prevOutputIndex
            const cacheKey = inp.prevTxHash + String.fromCharCode((_pi >>> 16) & 0xFFFF, _pi & 0xFFFF)
            const cached = cache.get(cacheKey)
            if (cached !== undefined) {
                r.oVal = cached
                cache.delete(cacheKey)   // spent — drop from cache
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

        // ── Phase 3: Stage all deletes ──
        const _tStage = Date.now()
        for (let i = 0; i < inputs.length; i++) {
            if (!resolved[i]) continue
            const inp = inputs[i]
            const r = resolved[i]

            if (r.inMem) {
                const inMemOKey = kOutputFromBuf(r.scriptPubKeyBuf, inp.prevTxHash, inp.prevOutputIndex)
                this.removeTransaction(inMemOKey, inp.blockHash)
                this.removeTransaction(r.hKey, inp.blockHash)
                continue
            }

            if (r.oVal == null) {
                await this.addTransaction("del", r.oKey)
                await this.addTransaction("del", r.hKey)
                continue
            }

            const mKey = kHintDel(inp.blockHash, inp.prevTxHash, inp.prevOutputIndex)
            const kKey = kOutDelFromBuf(inp.blockHash, r.scriptPubKeyBuf, inp.prevTxHash, inp.prevOutputIndex)
            await this.addTransaction("put", mKey, r.scriptPubKeyBuf)
            await this.addTransaction("put", kKey, r.oVal)
            await this.addTransaction("del", r.oKey)
            await this.addTransaction("del", r.hKey)
        }
        LevelUpStore.parseInBuckets.stage += Date.now() - _tStage

        return inputs.length
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

    // outputScript may be a Buffer (hot path) or a hex string (mempool / legacy callers).
    async insertOutputScriptBlock(outputScript, blockHash, blockHeight){
        // Mempool transactions have no confirmed block — S/Z prefix tracking is meaningless
        if (!blockHash) return true

        // Recreate the Set to avoid V8 tombstone accumulation from constant add+delete.
        // Covers all three add paths below with a single check per call.
        if (LevelUpStore.knownScripts.size > KNOWN_SCRIPTS_MAX) {
            LevelUpStore.knownScripts = new Set()
        }

        // Normalize the Set key to a latin1-encoded 32-char string when the input
        // is a Buffer. latin1 is half the size of hex and avoids the nibble
        // encoding cost — used only as the in-memory dedup key, never for DB ops.
        const isBuf = Buffer.isBuffer(outputScript)
        const scriptKey = isBuf ? outputScript.toString('latin1') : outputScript

        // Tier 0: known to exist from a previous batch — pure in-memory, no DB hit
        if (LevelUpStore.knownScripts.has(scriptKey)) {
            LevelUpStore.knownScriptsHits++
            return true
        }
        LevelUpStore.knownScriptsMisses++

        const sKey = isBuf ? kScriptBlkFromBuf(outputScript) : kScriptBlk(outputScript)

        // Tier 1: in current batch — avoids a real DB read
        if (this.getTransactionValue(sKey) !== null) {
            LevelUpStore.knownScripts.add(scriptKey)
            return true
        }

        // Tier 2: DB lookup
        try {
            await this.db.get(sKey)
            LevelUpStore.knownScripts.add(scriptKey)
            return true  // already exists
        } catch (err) {
            if (!err.notFound) throw err
        }

        // New script — insert and remember
        await this.addTransaction("put", sKey, encodeScriptBlk(blockHeight))
        const zKey = isBuf ? kBlkScriptFromBuf(blockHash, outputScript) : kBlkScript(blockHash, outputScript)
        await this.addTransaction("put", zKey, EMPTY)
        LevelUpStore.knownScripts.add(scriptKey)

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
