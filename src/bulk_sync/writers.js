'use strict'

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
 * XChain UTXO Tracker - Bulk Sync Writers
 *
 * Binary writers for the three parse-worker output streams. Every writer:
 *
 *   - opens a .tmp file and writes a 64-byte header with record_count=0
 *   - buffers records in a reusable scratch buffer to amortize write() syscalls
 *   - back-fills record_count at offset 20 on close() via a pwrite
 *   - atomically renames .tmp -> final path on clean close()
 *   - leaves the .tmp in place on abort() for post-mortem debugging
 *
 * See SPEC.md in this directory for the authoritative byte layouts.
 *
 ********************************************************************/

const fs = require('fs')

const HEADER_SIZE        = 64
// Format 2 carries the whole 32-byte txid wherever format 1 carried its first 8
// bytes, so the outputs/spends join and every derived key are on the full txid.
const FILE_VERSION       = 2

// Match dump.js codes for cross-tool compatibility of the shared prefix.
const CHAIN_CODES        = { bitcoin: 1, litecoin: 2, dogecoin: 3 }
const NETWORK_CODES      = { mainnet: 1, testnet: 2, regtest: 3 }

// The magic's last digit is the format: a format 1 file (8-byte txid fields)
// reads as a foreign magic, so the merge refuses it instead of misframing it.
const MAGIC_OUTPUTS      = Buffer.from('XCHNOUT2', 'ascii')
const MAGIC_SPENDS       = Buffer.from('XCHNSPD2', 'ascii')
const MAGIC_META         = Buffer.from('XCHNMTA2', 'ascii')

// Outputs record field offsets (layout in the OutputsWriter comment below). The
// sort and join key is the first OUTPUTS_KEY_SIZE bytes, (txid, vout).
const OUT_TXID     = 0
const OUT_VOUT     = 32
const OUT_VALUE    = 36
const OUT_HEIGHT   = 44
const OUT_SCRIPT   = 48
const OUT_BLOCK    = 80
const OUT_COINBASE = 112
const OUTPUTS_RECORD_SIZE = 113

// Spends record field offsets; the key is (prevTxid, prevVout).
const SPD_PREV_TXID    = 0
const SPD_PREV_VOUT    = 32
const SPD_SPENDER_TXID = 36
const SPENDS_RECORD_SIZE  = 68

// Bytes per tx in a meta block record's tx list.
const META_TXID_SIZE = 32

const FLUSH_BATCH_BYTES   = 256 * 1024 // ~256 KB per syscall

function writeHeader(fd, magic, chain, netName, firstHeight, lastHeight, recordSize) {
    if (!(chain in CHAIN_CODES))     throw new Error('Unknown chain: ' + chain)
    if (!(netName in NETWORK_CODES)) throw new Error('Unknown network: ' + netName)
    if (magic.length !== 8)          throw new Error('magic must be 8 bytes')

    const buf = Buffer.alloc(HEADER_SIZE)
    magic.copy(buf, 0)
    buf.writeUInt8(CHAIN_CODES[chain],       8)
    buf.writeUInt8(NETWORK_CODES[netName],   9)
    buf.writeUInt16LE(FILE_VERSION,         10)
    buf.writeUInt32LE(firstHeight,          12)
    buf.writeUInt32LE(lastHeight,           16)
    // 20..28 record_count (back-filled in close() via pwrite)
    buf.writeUInt32LE(recordSize,           28)
    // 32..64 reserved, already zero from Buffer.alloc
    fs.writeSync(fd, buf, 0, HEADER_SIZE)
}

function backfillRecordCount(fd, count) {
    const buf = Buffer.alloc(8)
    buf.writeBigUInt64LE(BigInt(count), 0)
    fs.writeSync(fd, buf, 0, 8, 20)
    // Durability before the tmp->final rename: without the fsync a power loss
    // can persist the rename but not the data tail or the count backfill,
    // leaving a FINAL-named file that defeats the SPEC's count-0 crash sentinel.
    fs.fsyncSync(fd)
}

function openTmp(finalPath) {
    const tmpPath = finalPath + '.tmp'
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath)
    const fd = fs.openSync(tmpPath, 'w')
    return { fd, tmpPath }
}

/**
 * Shared base for the two fixed-record streams (outputs, spends). Subclasses
 * implement append(...) to pack their record layout into the scratch buffer
 * at `slotOffset()`, then call `advance()`.
 */
class FixedRecordWriter {
    constructor(finalPath, magic, chain, netName, firstHeight, lastHeight, recordSize) {
        const h = openTmp(finalPath)
        this._fd         = h.fd
        this._tmpPath    = h.tmpPath
        this._finalPath  = finalPath
        this._recordSize = recordSize
        this._closed     = false

        writeHeader(this._fd, magic, chain, netName, firstHeight, lastHeight, recordSize)

        this._batchCap = Math.max(1, Math.floor(FLUSH_BATCH_BYTES / recordSize))
        this._batch    = Buffer.alloc(this._batchCap * recordSize)
        this._batchLen = 0
        this._count    = 0
    }

    slotOffset() {
        return this._batchLen * this._recordSize
    }

    advance() {
        this._batchLen++
        this._count++
        if (this._batchLen === this._batchCap) this.flush()
    }

    flush() {
        if (this._batchLen === 0) return
        fs.writeSync(this._fd, this._batch, 0, this._batchLen * this._recordSize)
        this._batchLen = 0
    }

    close() {
        if (this._closed) return
        this._closed = true
        this.flush()
        backfillRecordCount(this._fd, this._count)
        fs.closeSync(this._fd)
        fs.renameSync(this._tmpPath, this._finalPath)
    }

    abort() {
        if (this._closed) return
        this._closed = true
        try { fs.closeSync(this._fd) } catch (_) {}
    }

    get recordCount() { return this._count }
}

/**
 * outputs-*.dat: 113 bytes/record.
 *
 *   [0..32]    txid           32B raw, display order
 *   [32..36]   vout           uint32 BE
 *   [36..44]   value          uint64 BE (satoshis)
 *   [44..48]   height         int32 BE
 *   [48..80]   scriptPubKey   32B raw (sha256 of the script)
 *   [80..112]  blockHash      32B raw
 *   [112]      coinbase       uint8 (1 = coinbase output, 0 = normal)
 */
class OutputsWriter extends FixedRecordWriter {
    constructor(finalPath, chain, netName, firstHeight, lastHeight) {
        super(finalPath, MAGIC_OUTPUTS, chain, netName, firstHeight, lastHeight, OUTPUTS_RECORD_SIZE)
    }

    append(txid, vout, value, height, scriptPubKey, blockHash, isCoinbase) {
        const off = this.slotOffset()
        const b   = this._batch
        txid.copy(b, off + OUT_TXID, 0, 32)
        b.writeUInt32BE(vout >>> 0, off + OUT_VOUT)
        b.writeBigUInt64BE(typeof value === 'bigint' ? value : BigInt(value), off + OUT_VALUE)
        b.writeInt32BE(height, off + OUT_HEIGHT)
        scriptPubKey.copy(b, off + OUT_SCRIPT, 0, 32)
        blockHash.copy(b, off + OUT_BLOCK, 0, 32)
        // Coinbase flag rides the value byte-for-byte through the sort and the
        // anti-join into the O-record, where it drives maturity gating.
        b.writeUInt8(isCoinbase ? 1 : 0, off + OUT_COINBASE)
        this.advance()
    }
}

/**
 * spends-*.dat: 68 bytes/record. Coinbases are NOT emitted.
 *
 *   [0..32]   prevTxid         32B raw, display order
 *   [32..36]  prevVout         uint32 BE
 *   [36..68]  spenderTxid      32B raw, display order
 */
class SpendsWriter extends FixedRecordWriter {
    constructor(finalPath, chain, netName, firstHeight, lastHeight) {
        super(finalPath, MAGIC_SPENDS, chain, netName, firstHeight, lastHeight, SPENDS_RECORD_SIZE)
    }

    append(prevTxid, prevVout, spenderTxid) {
        const off = this.slotOffset()
        const b   = this._batch
        prevTxid.copy(b, off + SPD_PREV_TXID, 0, 32)
        b.writeUInt32BE(prevVout >>> 0, off + SPD_PREV_VOUT)
        spenderTxid.copy(b, off + SPD_SPENDER_TXID, 0, 32)
        this.advance()
    }
}

/**
 * meta-*.dat: variable-length, inlined tx list per block.
 *
 *   Block record (76 + 32*tx_count bytes):
 *     [0..4]    height        uint32 BE
 *     [4..8]    timestamp     uint32 BE
 *     [8..40]   blockHash     32B raw
 *     [40..72]  previousHash  32B raw
 *     [72..76]  tx_count      uint32 BE
 *     [76..]    tx_count × txid (32B each, display order)
 *
 * record_count in the header counts BLOCK records, not txs.
 * Blocks must be written in ascending height order.
 */
class MetaWriter {
    constructor(finalPath, chain, netName, firstHeight, lastHeight) {
        const h = openTmp(finalPath)
        this._fd        = h.fd
        this._tmpPath   = h.tmpPath
        this._finalPath = finalPath
        this._closed    = false

        writeHeader(this._fd, MAGIC_META, chain, netName, firstHeight, lastHeight, 0)

        this._buf   = Buffer.alloc(FLUSH_BATCH_BYTES)
        this._pos   = 0
        this._count = 0
    }

    writeBlock(height, timestamp, blockHash, previousHash, txidList) {
        const txCount    = txidList.length
        const recordSize = 76 + META_TXID_SIZE * txCount
        this.ensure(recordSize)

        const b = this._buf
        let   off = this._pos
        b.writeUInt32BE(height >>> 0,    off); off += 4
        b.writeUInt32BE(timestamp >>> 0, off); off += 4
        blockHash.copy(b, off, 0, 32);         off += 32
        previousHash.copy(b, off, 0, 32);      off += 32
        b.writeUInt32BE(txCount >>> 0,   off); off += 4
        for (let i = 0; i < txCount; i++) {
            txidList[i].copy(b, off, 0, META_TXID_SIZE)
            off += META_TXID_SIZE
        }
        this._pos = off
        this._count++
    }

    ensure(needed) {
        if (this._pos + needed <= this._buf.length) return
        this.flush()
        if (needed > this._buf.length) {
            this._buf = Buffer.alloc(needed)
        }
    }

    flush() {
        if (this._pos === 0) return
        fs.writeSync(this._fd, this._buf, 0, this._pos)
        this._pos = 0
    }

    close() {
        if (this._closed) return
        this._closed = true
        this.flush()
        backfillRecordCount(this._fd, this._count)
        fs.closeSync(this._fd)
        fs.renameSync(this._tmpPath, this._finalPath)
    }

    abort() {
        if (this._closed) return
        this._closed = true
        try { fs.closeSync(this._fd) } catch (_) {}
    }

    get recordCount() { return this._count }
}

module.exports = {
    OutputsWriter,
    SpendsWriter,
    MetaWriter,
    HEADER_SIZE,
    OUTPUTS_RECORD_SIZE,
    SPENDS_RECORD_SIZE,
    OUT_TXID, OUT_VOUT, OUT_VALUE, OUT_HEIGHT, OUT_SCRIPT, OUT_BLOCK, OUT_COINBASE,
    SPD_PREV_TXID, SPD_PREV_VOUT, SPD_SPENDER_TXID,
    META_TXID_SIZE,
    MAGIC_OUTPUTS,
    MAGIC_SPENDS,
    MAGIC_META,
    CHAIN_CODES,
    NETWORK_CODES,
    FILE_VERSION,
}
