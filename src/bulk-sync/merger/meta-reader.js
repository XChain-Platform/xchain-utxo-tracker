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
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain UTXO Tracker - Bulk Sync Meta Reader
 *
 * Streams blocks out of a meta-*.dat file written by MetaWriter.
 *
 * File layout (see src/bulk-sync/writers.js):
 *   - 64-byte header: magic XCHNMTA1, chain/net codes, version, first/last
 *     height, record_count (blocks) at offset 20, record_size=0 at 28.
 *   - Variable-length block records:
 *       height(4 BE) | timestamp(4 BE) | blockHash(32) | previousHash(32)
 *       | tx_count(4 BE) | tx_count × txHash8(8)
 *
 * The generator yields objects whose `blockHash`, `previousHash` and each
 * entry of `txHash8List` are Buffer VIEWS into a single scratch buffer —
 * they are invalidated on the next iteration. Callers that need to retain
 * bytes across iterations must Buffer.from(view) to copy.
 *
 ********************************************************************/

const fs = require('fs')

const HEADER_SIZE = 64
const MIN_RECORD_SIZE = 76 // header fields before tx list

const MAGIC_META = Buffer.from('XCHNMTA1', 'ascii')
const IO_CHUNK_BYTES = 256 * 1024

class MetaReader {
    constructor(filePath) {
        this._fd   = fs.openSync(filePath, 'r')
        this._size = fs.statSync(filePath).size
        this._path = filePath

        if (this._size < HEADER_SIZE) {
            fs.closeSync(this._fd)
            throw new Error(`meta file too small: ${this._size} bytes (${filePath})`)
        }

        const hdr = Buffer.alloc(HEADER_SIZE)
        let read = 0
        while (read < HEADER_SIZE) {
            const n = fs.readSync(this._fd, hdr, read, HEADER_SIZE - read, read)
            if (n === 0) throw new Error('short header read')
            read += n
        }
        if (hdr.slice(0, 8).compare(MAGIC_META) !== 0) {
            fs.closeSync(this._fd)
            throw new Error(`bad meta magic in ${filePath}`)
        }
        this.chainCode    = hdr.readUInt8(8)
        this.networkCode  = hdr.readUInt8(9)
        this.version      = hdr.readUInt16LE(10)
        this.firstHeight  = hdr.readUInt32LE(12)
        this.lastHeight   = hdr.readUInt32LE(16)
        this.blockCount   = Number(hdr.readBigUInt64LE(20))
        this._pos         = HEADER_SIZE

        // Scratch buffer grows on demand as needed for oversized blocks.
        this._scratch = Buffer.alloc(Math.max(IO_CHUNK_BYTES, MIN_RECORD_SIZE * 2))
        this._closed  = false
    }

    _ensureScratch(need) {
        if (need > this._scratch.length) {
            let cap = this._scratch.length * 2
            while (cap < need) cap *= 2
            this._scratch = Buffer.alloc(cap)
        }
    }

    _readInto(buf, offset, length, filePos) {
        let read = 0
        while (read < length) {
            const n = fs.readSync(this._fd, buf, offset + read, length - read, filePos + read)
            if (n === 0) throw new Error(`short read at ${filePos + read}`)
            read += n
        }
    }

    *blocks() {
        let yielded = 0
        while (this._pos < this._size) {
            const remaining = this._size - this._pos
            if (remaining < MIN_RECORD_SIZE) {
                throw new Error(`meta truncated: ${remaining} bytes left at pos ${this._pos}, need ≥${MIN_RECORD_SIZE}`)
            }

            // Read the fixed 76-byte prefix first, to discover tx_count.
            this._ensureScratch(MIN_RECORD_SIZE)
            this._readInto(this._scratch, 0, MIN_RECORD_SIZE, this._pos)

            const txCount = this._scratch.readUInt32BE(72)
            const total   = MIN_RECORD_SIZE + 8 * txCount
            if (total > remaining) {
                throw new Error(`meta truncated: record at ${this._pos} needs ${total}B, only ${remaining}B left`)
            }

            this._ensureScratch(total)
            if (txCount > 0) {
                this._readInto(this._scratch, MIN_RECORD_SIZE, 8 * txCount, this._pos + MIN_RECORD_SIZE)
            }

            const height       = this._scratch.readUInt32BE(0)
            const timestamp    = this._scratch.readUInt32BE(4)
            const blockHash    = this._scratch.subarray(8, 40)
            const previousHash = this._scratch.subarray(40, 72)
            const txHash8List  = new Array(txCount)
            for (let i = 0; i < txCount; i++) {
                const off = MIN_RECORD_SIZE + 8 * i
                txHash8List[i] = this._scratch.subarray(off, off + 8)
            }

            this._pos += total
            yielded++

            yield { height, timestamp, blockHash, previousHash, txHash8List }
        }

        if (yielded !== this.blockCount) {
            throw new Error(`meta block_count=${this.blockCount} but yielded ${yielded}`)
        }
    }

    close() {
        if (this._closed) return
        this._closed = true
        try { fs.closeSync(this._fd) } catch (_) {}
    }
}

module.exports = { MetaReader, HEADER_SIZE: HEADER_SIZE, MAGIC_META }
