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
 *   W: [0x57][blockHash(32)][txHash8(8)][outputIndex(4)]             = 45 B
 *
 * Value layouts:
 *   B: [height(4)][timestamp(4)][previousHash(32)]                   = 40 B
 *   T: [blockHash(32)]                                                = 32 B
 *   I: [txHash8(8)]                                                   =  8 B
 *   O: [value(8)][height(4)][fullTxHash(32)]{[coinbase(1)]}          = 44/45 B
 *   H: [scriptPubKey(32)]                                             = 32 B
 *   S: [height(4)]                                                    =  4 B
 *   W: [scriptPubKey(32)]                                             = 32 B
 *
 ********************************************************************/

// Load required libraries
const util = require('./util')

// Debug-only tracing for the missing-O-record investigation. Gated behind
// TRACE_UTXO=1 to keep prod cost at zero. Emits one line per insertOutput,
// one per staged O deletion in removeOutputsWithInputsBatch, and a summary
// per endTransaction. Logs go to stdout (docker logs).
const DEBUG_TRACE = process.env.TRACE_UTXO === '1' || process.env.TRACE_UTXO === 'true'

const { ClassicLevel } = require('classic-level')
const { MemoryLevel } = require('memory-level')
const bs = require("binary-search")

// String-keyed metadata entries. The DB is opened with keyEncoding:'buffer',
// so these are stored as their UTF-8 byte Buffers (lexicographically after the
// single-byte binary prefixes, which never collide with these ASCII keys).
const PREFIX_LAST_BLOCK_HEIGHT = Buffer.from("LAST_BLOCK_HEIGHT")
const PREFIX_LAST_BLOCK_HASH   = Buffer.from("LAST_BLOCK_HASH")

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
const P_OUT_BLK    = 0x57  // 'W' - creation-block reverse index for outputs

// ─── Binary helpers ───────────────────────────────────────────────────────────

function h2b(hex) { return Buffer.from(hex, 'hex') }
function b2h(buf) { return Buffer.isBuffer(buf) ? buf.toString('hex') : buf }
function pb(p)    { return Buffer.from([p]) }

function idxBuf(n) {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(n >>> 0, 0)
    return b
}

// ─── Address-query pagination ──────────────────────────────────────────────────
// A single-address output scan (O-prefix range) can return millions of rows for a
// mega miner-coinbase/payout address. Materializing them all into one array OOMs
// the process and takes the tracker down for every caller. getOutputsScriptPubKey
// therefore supports a bounded page (`limit` + `after` cursor) and a fail-loud
// safety ceiling (`maxOutputs`) for unbounded callers.

// Thrown when an unbounded scan would exceed the safety ceiling. The API layer
// maps `.code` to HTTP 413 so callers switch to ?limit=&after= pagination.
class AddressTooLargeError extends Error {
    constructor(maxOutputs) {
        super(`address has more than ${maxOutputs} outputs; page the result with ?limit=&after=`)
        this.name = 'AddressTooLargeError'
        this.code = 'ADDRESS_TOO_LARGE'
        this.maxOutputs = maxOutputs
        // JSON-RPC router serializes Error instances by enumerable props only;
        // .code is a non-enumerable own property so it arrives as null at the
        // client. Mirror it into .data so the router preserves it.
        this.data = { code: this.code }
    }
}

// Thrown when a pagination cursor is malformed (the API layer maps to HTTP 400).
class InvalidCursorError extends Error {
    constructor(cursor) {
        super(`invalid pagination cursor ${JSON.stringify(cursor)} (expected "<txHash8Hex>:<vout>")`)
        this.name = 'InvalidCursorError'
        this.code = 'INVALID_CURSOR'
        // Mirror .code into .data for the same reason as AddressTooLargeError above.
        this.data = { code: this.code }
    }
}

// Parse an "<txHash8Hex>:<vout>" cursor: the txid (8-byte/16-hex O-key prefix)
// and vout of the last output returned by the previous page. Returns null on any
// malformed input so the caller rejects it rather than crashing the iterator.
function parseOutputCursor(cursor) {
    if (typeof cursor !== 'string') return null
    const sep = cursor.indexOf(':')
    if (sep <= 0) return null
    const txHash8Hex = cursor.slice(0, sep)
    const voutStr    = cursor.slice(sep + 1)
    if (!/^[0-9a-fA-F]{16}$/.test(txHash8Hex)) return null
    if (!/^\d+$/.test(voutStr)) return null
    const vout = Number(voutStr)
    if (!Number.isInteger(vout) || vout < 0 || vout > 0xFFFFFFFF) return null
    return { txHash8Hex: txHash8Hex.toLowerCase(), vout }
}

function rangeEnd(prefix) {
    // The 0xFF suffix must be at least as long as the longest key suffix of ANY
    // range scan, or a key whose leading suffix bytes are all 0xFF sorts above the
    // (shorter) inclusive `lte` bound and is silently dropped from the iterator.
    // The previous 12-byte suffix covered only the 12-byte-suffix scans (O/H/I/M:
    // 33-byte prefix over 45-byte keys), but UNDER-covered the reorg-consistency
    // scans: the K/P_OUT_DEL restore scan uses a 33-byte [K+blockHash] prefix over
    // 77-byte keys (44-byte suffix) and the Z/P_BLK_SCRIPT scan leaves a 32-byte
    // scriptHash suffix. A dropped K key means a spent output is NOT restored on a
    // reorg rollback (permanent balance under-count); a dropped Z key leaves a stale
    // first-seen (S) record. 64 bytes covers the current maximum (44) with margin; a
    // longer all-0xFF upper bound never bleeds into the next prefix (the differing
    // prefix byte is compared first) and never excludes a valid key.
    return Buffer.concat([prefix, Buffer.alloc(64, 0xFF)])
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
// buf.write(hex, offset, 'hex'): avoids the 3-5 temporary Buffers that
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
    // The I-key carries only the 8-byte (16-hex) txid prefix. Fail loudly if a
    // caller passes a full 64-hex txid: today that resolves to the right key
    // purely by buffer-overrun coincidence (write caps at the 12 free bytes,
    // then writeUInt32BE(idx,9) overwrites the overrun), so any future change to
    // this layout would silently make every getInput miss. Assert the contract.
    if (prevTxHash8Hex.length !== 16) {
        throw new Error(`kInput expects a 16-hex (8-byte) txid prefix, got ${prevTxHash8Hex.length} chars`)
    }
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
// W key: creation-block reverse index. Keyed by the block an output was created
// in, so a rolled-back block can enumerate (and delete) the O/H entries it
// produced. Mirrors the K layout but keyed on the creation block rather than the
// spend block. Value is the 32-byte scriptPubKey needed to rebuild the O key.
function kOutBlk(blockHashHex, txHash8Hex, idx) {
    const buf = Buffer.allocUnsafe(45)
    buf[0] = P_OUT_BLK
    buf.write(blockHashHex, 1, 'hex')
    buf.write(txHash8Hex, 33, 'hex')
    buf.writeUInt32BE(idx >>> 0, 41)
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

// O value: [value(8)][height(4)][fullTxHash(32)] = 44 bytes, plus an OPTIONAL
// 45th coinbase-flag byte (0x01) appended only for coinbase outputs (L-4).
// height = -1 stored as 0xFFFFFFFF (twos-complement Int32)
const ZERO_HASH = '0'.repeat(64)
function encodeOutput(value, height, fullTxHashHex, isCoinbase = false) {
    // Non-coinbase outputs (the overwhelming majority) stay exactly 44 bytes, so
    // existing records and encodings are byte-identical; only coinbase outputs
    // grow by one flag byte. This keeps the change reindex-free: a legacy 44-byte
    // record decodes as non-coinbase, which is the pre-L-4 behaviour.
    const buf = Buffer.alloc(isCoinbase ? 45 : 44)
    buf.writeBigUInt64BE(BigInt(value), 0)
    buf.writeInt32BE(height != null ? height : -1, 8)
    // A falsy fullTxHashHex leaves bytes 12..44 as the alloc-zeroed 0x00…00,
    // i.e. ZERO_HASH. decodeOutput maps that sentinel back to t: null, which
    // callers (getUtxosAddress) treat as "no full txid available". All current
    // insertion paths supply fullTxHash, so a zero hash on read means the record
    // predates this field; such a LevelDB must be re-indexed before use, since
    // the 8-byte O-key prefix is not a spendable txid.
    if (fullTxHashHex) h2b(fullTxHashHex).copy(buf, 12)
    if (isCoinbase) buf[44] = 1
    return buf
}
function decodeOutput(buf) {
    const fullTxHash = b2h(buf.slice(12, 44))
    return {
        v: buf.readBigUInt64BE(0).toString(),
        h: buf.readInt32BE(8),
        // ZERO_HASH is the "no full txid" sentinel (see encodeOutput).
        t: fullTxHash === ZERO_HASH ? null : fullTxHash,
        // Optional coinbase flag (L-4); legacy 44-byte records read as false.
        cb: buf.length > 44 && buf[44] === 1
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
                this.db = new MemoryLevel({ keyEncoding: 'buffer', valueEncoding: 'buffer' })
            } else {
                // A large block cache keeps hot UTXO index blocks resident: on big
                // mainnet DBs sat on spinning disks, the 8 MB default turns every cold
                // lookup into a random seek and IO-bounds catch-up. Tunable via env.
                this.db = new ClassicLevel("/data/"+this.dbName, { keyEncoding: 'buffer', valueEncoding: 'buffer',
                    cacheSize: parseInt(process.env.LEVELDB_CACHE_BYTES ?? String(4 * 1024 * 1024 * 1024), 10),
                    writeBufferSize: parseInt(process.env.LEVELDB_WRITE_BUFFER_BYTES ?? String(64 * 1024 * 1024), 10) })
            }
            // abstract-level opens lazily on first op; open explicitly so any
            // open/create error surfaces here rather than on the first read.
            await this.db.open()
            return this.db
        } catch (err){
            throw new Error("Couldn't open/create LevelDB '" + this.dbName + "': " + (err && err.message), { cause: err })
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
                if (DEBUG_TRACE) {
                    let puts = 0, dels = 0, oPut = 0, oDel = 0
                    for (const item of transactionArrayFromMap) {
                        if (item.type === 'put') puts++; else if (item.type === 'del') dels++
                        // O-prefix is 0x4F; first byte of binary key tells us which prefix
                        if (Buffer.isBuffer(item.key) && item.key[0] === 0x4F) {
                            if (item.type === 'put') oPut++; else if (item.type === 'del') oDel++
                        }
                    }
                    console.log(`TRACE endTransaction db=${this.dbName} total=${transactionArrayFromMap.length} puts=${puts} dels=${dels} oPuts=${oPut} oDels=${oDel}`)
                }
                await this.db.batch(transactionArrayFromMap)
            }
            this.transactionArray = null
            this.deletedTransactionArray = null
        } catch (err){
            console.log("There were errors trying to insert data in a batch")
            console.log(err)
            throw new Error("Error in LevelDB batch inserting")
        }
    }

    // ─── Block height / hash ─────────────────────────────────────────────────

    async getLastBlockHeight(){
        const value = await this.db.get(PREFIX_LAST_BLOCK_HEIGHT)
        if (value === undefined) return -1
        return parseInt(value.toString(), 16)
    }

    // Records the block-tip in the same in-flight batch as the UTXO inserts
    // produced while processing this block. Because endTransaction() flushes
    // the whole batch atomically via db.batch(), the on-disk last-block-height
    // and all of the block's outputs become queryable together, never out of
    // order. This is the load-bearing guarantee that get_sync_status and
    // is_quiescent rely on: callers can treat a returned committed_height as
    // "every output in blocks 0..N is queryable right now".
    async setLastBlockHeight(height){
        // valueEncoding is 'buffer': store the hex string as its UTF-8 bytes.
        await this.addTransaction("put", PREFIX_LAST_BLOCK_HEIGHT, Buffer.from(height.toString(16)))
        return true
    }

    async getLastBlockHash(){
        const value = await this.db.get(PREFIX_LAST_BLOCK_HASH)
        if (value === undefined) return null
        return value.toString()
    }

    async setLastBlockHash(hash){
        // valueEncoding is 'buffer': store the hash string as its UTF-8 bytes.
        return await this.addTransaction("put", PREFIX_LAST_BLOCK_HASH, Buffer.from(hash))
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
            throw new Error("removeLastStoredBlock failed for " + blockHash + ": " + (err && err.message), { cause: err })
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
        const buf = await this.db.get(kBlock(blockHash))
        if (buf === undefined) return null
        return decodeBlock(buf)
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
    }

    async getTransaction(txHashWithPrefix){
        // Accepts full key as hex string (prefix included) for backward compatibility
        const value = await this.db.get(h2b(txHashWithPrefix))
        return value === undefined ? null : value
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
        const value = await this.db.get(kInput(txHash8, outputIndex))
        return value === undefined ? null : value
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
        let inputsCount = 0

        for await (const [key, value] of this.db.iterator(options)) {
            const txHash = decodeInputVal(value).th
            if (!txids8.includes(txHash)) {
                await this.addTransaction("del", key, null)
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

        for await (const [key] of this.db.iterator(options)) {
            // J key layout: [J(1)][txHash8(8)][prevTxHash8(8)][outputIndex(4)]
            const prevTxHash8Buf = key.slice(9, 17)
            const idxBuf         = key.slice(17, 21)

            await this.addTransaction(
                "del",
                Buffer.concat([pb(P_INPUT), prevTxHash8Buf, idxBuf]),
                null
            )
            await this.addTransaction("del", key, null)
            inputsCount++
        }

        return inputsCount
    }

    async deleteInputsByHints(txids){
        const counts = await Promise.all(txids.map(txid => this.deleteInputsByHint(txid)))
        return counts.reduce((sum, n) => sum + n, 0)
    }

    // ─── Output (O prefix) ───────────────────────────────────────────────────

    // output.scriptPubKey may be a Buffer (hot path) or a hex string (mempool / legacy callers).
    async insertOutput(output) {
        const oVal = encodeOutput(output.value, output.height, output.fullTxHash || null, output.coinbase === true)

        // Populate the recent-output cache so Phase 2 of removeOutputsWithInputsBatch
        // can absorb spends of this output without a DB read.
        // Pack outputIndex into 2 BMP chars (high/low 16 bits) instead of
        // ":" + String(n): avoids the NumberPrototypeToString hot spot from the
        // profile while covering the full 32-bit range.
        //
        // outputCache is a process-global static shared by the confirmed and mempool
        // stores. The mempool store also calls insertOutput (height=-1), so its
        // entries land here too. Correctness relies on block Pass 1 (parseTxOutputs /
        // insertOutput) overwriting any mempool cache entry with the confirmed height
        // before Pass 2 (removeOutputsWithInputsBatch) reads it. A confirmed block
        // can only spend an already-mined output, so by the time Pass 2 runs, all
        // relevant cache entries already carry the confirmed height from Pass 1.
        // The reorg path (removeCreatedOutputsInBlock) deletes O records for orphaned
        // outputs but does not evict the cache; stale entries from the orphaned block
        // are never re-read because the spending tx is also gone after the reorg.
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
        if (DEBUG_TRACE) {
            const shHex = Buffer.isBuffer(output.scriptPubKey) ? output.scriptPubKey.toString('hex') : output.scriptPubKey
            console.log(`TRACE insertOutput db=${this.dbName} sh=${shHex} tx8=${output.txHash} idx=${output.outputIndex} val=${output.value} h=${output.height}`)
        }
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

    // ─── Output creation-block reverse index (W prefix) ──────────────────────

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
    }

    // ─── Output + hint removal (REMOVE_SPENT path) ───────────────────────────

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
    }

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
    }

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
            } else {
                console.log("Warning: Missing outputHintKey for input "+JSON.stringify(input)+" - output may have been indexed before REMOVE_SPENT was enabled")
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
    }

    // Batch version of removeOutputWithInput: collects all inputs for a block,
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

        // ── Phase 3: Stage all deletes ──
        const _tStage = Date.now()
        for (let i = 0; i < inputs.length; i++) {
            if (!resolved[i]) continue
            const inp = inputs[i]
            const r = resolved[i]

            if (r.inMem) {
                const inMemOKey = kOutputFromBuf(r.scriptPubKeyBuf, inp.prevTxHash, inp.prevOutputIndex)
                if (DEBUG_TRACE) {
                    console.log(`TRACE delOutput db=${this.dbName} path=inMem sh=${r.scriptPubKeyBuf.toString('hex')} tx8=${inp.prevTxHash} idx=${inp.prevOutputIndex} blk=${inp.blockHash}`)
                }
                // Capture the staged output value BEFORE removal so a cross-block
                // spend writes durable K/M restore records (see
                // writeCrossBlockSpendRecovery). Same-block spends write nothing.
                const inMemOVal = this.getTransactionValue(inMemOKey)
                this.removeTransaction(inMemOKey, inp.blockHash)
                this.removeTransaction(r.hKey, inp.blockHash)
                await this.writeCrossBlockSpendRecovery(inp, r.scriptPubKeyBuf, inMemOVal)
                continue
            }

            if (r.oVal == null) {
                if (DEBUG_TRACE) {
                    console.log(`TRACE delOutput db=${this.dbName} path=noOval sh=${r.scriptPubKeyBuf.toString('hex')} tx8=${inp.prevTxHash} idx=${inp.prevOutputIndex} blk=${inp.blockHash}`)
                }
                await this.addTransaction("del", r.oKey)
                await this.addTransaction("del", r.hKey)
                continue
            }

            const mKey = kHintDel(inp.blockHash, inp.prevTxHash, inp.prevOutputIndex)
            const kKey = kOutDelFromBuf(inp.blockHash, r.scriptPubKeyBuf, inp.prevTxHash, inp.prevOutputIndex)
            if (DEBUG_TRACE) {
                console.log(`TRACE delOutput db=${this.dbName} path=archive sh=${r.scriptPubKeyBuf.toString('hex')} tx8=${inp.prevTxHash} idx=${inp.prevOutputIndex} blk=${inp.blockHash}`)
            }
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
    }

    async deleteOutputsByHints(txids){
        const counts = await Promise.all(txids.map(txid => this.deleteOutputsByHint(txid)))
        return counts.reduce((sum, n) => sum + n, 0)
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
    }

    async recoverDeletedOutputsHints(blockHash){
        const prefixBuf = Buffer.concat([pb(P_HINT_DEL), h2b(blockHash)])

        const options = {
            gte: prefixBuf,
            lte: rangeEnd(prefixBuf),
            keys: true,
            values: true
        }

        for await (const [key, value] of this.db.iterator(options)) {
            const suffix  = key.slice(33)  // skip [M(1)][blockHash(32)]
            const hKey = Buffer.concat([pb(P_OUT_HINT), suffix])
            await this.addTransaction("put", hKey, value)
            await this.addTransaction("del", key)
        }
    }

    // ─── Output script block (S / Z prefix) ──────────────────────────────────

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
    }

    async getOutputScriptBlock(outputScript){
        const buf = await this.db.get(kScriptBlk(outputScript))
        if (buf === undefined) return null
        return decodeScriptBlk(buf)
    }

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
    }

    // Delete the O/H entries for every output CREATED in the given block, using
    // the W creation-block reverse index. Called during a reorg to purge outputs
    // born in a rolled-back block that were never spent (K/M recovery only
    // restores outputs spent in the rolled-back block, so without this they would
    // linger as phantom UTXOs and inflate balances permanently. Must run after
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
    }

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
    }

    // ─── Queries ─────────────────────────────────────────────────────────────

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
    }

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
    }

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
    }

    // ─── Mempool helpers ─────────────────────────────────────────────────────

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
    }

    // ─── Generic key-pattern scan (used by API) ───────────────────────────────
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
            console.log("Error getting values from patterns")
            console.log(err)
            throw err
        }

        return values
    }
}

module.exports = LevelUpStore
module.exports.AddressTooLargeError = AddressTooLargeError
module.exports.InvalidCursorError  = InvalidCursorError
// Exported so the bulk-sync loader can write O-record values byte-identically
// to the live path (optional 45th coinbase byte, L-4), reusing this single
// source of the encoding instead of duplicating the format.
module.exports.encodeOutput = encodeOutput
module.exports.decodeOutput = decodeOutput
