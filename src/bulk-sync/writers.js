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
const FILE_VERSION       = 1

// Match dump.js codes for cross-tool compatibility of the shared prefix.
const CHAIN_CODES        = { bitcoin: 1, litecoin: 2, dogecoin: 3 }
const NETWORK_CODES      = { mainnet: 1, testnet: 2, regtest: 3 }

const MAGIC_OUTPUTS      = Buffer.from('XCHNOUT1', 'ascii')
const MAGIC_SPENDS       = Buffer.from('XCHNSPD1', 'ascii')
const MAGIC_META         = Buffer.from('XCHNMTA1', 'ascii')

// 121 bytes: the 120-byte body plus a trailing coinbase-flag byte (L-4). The
// record_size header field (offset 28) is the explicit format discriminator: a
// legacy dump reports 120 and its outputs carry no flag; the merger reads the
// header size and treats missing-byte as non-coinbase, so old dumps still merge.
const OUTPUTS_RECORD_SIZE = 121
const SPENDS_RECORD_SIZE  = 20

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
 * at `_slotOffset()`, then call `_advance()`.
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

    _slotOffset() {
        return this._batchLen * this._recordSize
    }

    _advance() {
        this._batchLen++
        this._count++
        if (this._batchLen === this._batchCap) this._flush()
    }

    _flush() {
        if (this._batchLen === 0) return
        fs.writeSync(this._fd, this._batch, 0, this._batchLen * this._recordSize)
        this._batchLen = 0
    }

    close() {
        if (this._closed) return
        this._closed = true
        this._flush()
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
 * outputs-*.dat: 121 bytes/record.
 *
 *   [0..8]     txHash8        8B raw
 *   [8..12]    vout           uint32 BE
 *   [12..20]   value          uint64 BE (satoshis)
 *   [20..24]   height         int32 BE
 *   [24..56]   fullTxHash     32B raw
 *   [56..88]   scriptPubKey   32B raw
 *   [88..120]  blockHash      32B raw
 *   [120]      coinbase       uint8 (1 = coinbase output, 0 = normal) (L-4)
 */
class OutputsWriter extends FixedRecordWriter {
    constructor(finalPath, chain, netName, firstHeight, lastHeight) {
        super(finalPath, MAGIC_OUTPUTS, chain, netName, firstHeight, lastHeight, OUTPUTS_RECORD_SIZE)
    }

    append(txHash8, vout, value, height, fullTxHash, scriptPubKey, blockHash, isCoinbase) {
        const off = this._slotOffset()
        const b   = this._batch
        txHash8.copy(b, off + 0, 0, 8)
        b.writeUInt32BE(vout >>> 0, off + 8)
        b.writeBigUInt64BE(typeof value === 'bigint' ? value : BigInt(value), off + 12)
        b.writeInt32BE(height, off + 20)
        fullTxHash.copy(b, off + 24, 0, 32)
        scriptPubKey.copy(b, off + 56, 0, 32)
        blockHash.copy(b, off + 88, 0, 32)
        // Coinbase flag rides the value byte-for-byte through the sort and the
        // anti-join into the O-record, where it drives maturity gating (L-4).
        b.writeUInt8(isCoinbase ? 1 : 0, off + 120)
        this._advance()
    }
}

/**
 * spends-*.dat: 20 bytes/record. Coinbases are NOT emitted.
 *
 *   [0..8]    prevTxHash8      8B raw
 *   [8..12]   prevVout         uint32 BE
 *   [12..20]  spenderTxHash8   8B raw
 */
class SpendsWriter extends FixedRecordWriter {
    constructor(finalPath, chain, netName, firstHeight, lastHeight) {
        super(finalPath, MAGIC_SPENDS, chain, netName, firstHeight, lastHeight, SPENDS_RECORD_SIZE)
    }

    append(prevTxHash8, prevVout, spenderTxHash8) {
        const off = this._slotOffset()
        const b   = this._batch
        prevTxHash8.copy(b, off + 0, 0, 8)
        b.writeUInt32BE(prevVout >>> 0, off + 8)
        spenderTxHash8.copy(b, off + 12, 0, 8)
        this._advance()
    }
}

/**
 * meta-*.dat: variable-length, inlined tx list per block.
 *
 *   Block record (76 + 8*tx_count bytes):
 *     [0..4]    height        uint32 BE
 *     [4..8]    timestamp     uint32 BE
 *     [8..40]   blockHash     32B raw
 *     [40..72]  previousHash  32B raw
 *     [72..76]  tx_count      uint32 BE
 *     [76..]    tx_count × txHash8 (8B each)
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

    writeBlock(height, timestamp, blockHash, previousHash, txHash8List) {
        const txCount    = txHash8List.length
        const recordSize = 76 + 8 * txCount
        this._ensure(recordSize)

        const b = this._buf
        let   off = this._pos
        b.writeUInt32BE(height >>> 0,    off); off += 4
        b.writeUInt32BE(timestamp >>> 0, off); off += 4
        blockHash.copy(b, off, 0, 32);         off += 32
        previousHash.copy(b, off, 0, 32);      off += 32
        b.writeUInt32BE(txCount >>> 0,   off); off += 4
        for (let i = 0; i < txCount; i++) {
            txHash8List[i].copy(b, off, 0, 8)
            off += 8
        }
        this._pos = off
        this._count++
    }

    _ensure(needed) {
        if (this._pos + needed <= this._buf.length) return
        this._flush()
        if (needed > this._buf.length) {
            this._buf = Buffer.alloc(needed)
        }
    }

    _flush() {
        if (this._pos === 0) return
        fs.writeSync(this._fd, this._buf, 0, this._pos)
        this._pos = 0
    }

    close() {
        if (this._closed) return
        this._closed = true
        this._flush()
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
    MAGIC_OUTPUTS,
    MAGIC_SPENDS,
    MAGIC_META,
    CHAIN_CODES,
    NETWORK_CODES,
    FILE_VERSION,
}
