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
 * XChain UTXO Tracker - Bulk Sync Streaming Left-Anti-Join
 *
 * Takes two fixed-record files sorted by the same key (first `keySize`
 * bytes of each record) and emits only LEFT records whose key does NOT
 * appear in RIGHT. The output records are byte-identical copies of the
 * LEFT records; RIGHT is consumed only for its keys.
 *
 * For the bulk-sync pipeline: left = outputs-by-tx.dat, right =
 * spends-by-prevtx.dat, output = live-utxos.dat.
 *
 * Assumptions:
 *   - Both files are sorted ascending by the first `keySize` bytes.
 *   - In the canonical case keys are unique within each file. Duplicates
 *     are handled as follows: when equal keys are encountered, one LEFT
 *     and one RIGHT are consumed per iteration. If the duplicate count
 *     differs across sides, the surplus LEFTs are emitted and surplus
 *     RIGHTs are counted as `orphanSpends`.
 *   - A RIGHT record whose key does not appear in LEFT is an "orphan
 *     spend". In a well-formed blockchain dump these should be zero;
 *     we count them and optionally log via `onAnomaly`.
 *
 ********************************************************************/

const fs = require('fs')

const IO_CHUNK_BYTES = 256 * 1024

function noop() {}

/**
 * Buffered sequential reader of fixed-size records. Yields a Buffer VIEW
 * into a scratch buffer for each record; views are invalidated on the
 * next `next()` call, so the caller must consume or copy immediately.
 */
class RecordReader {
    constructor(filePath, headerSize, recordSize) {
        this._fd         = fs.openSync(filePath, 'r')
        this._pos        = headerSize
        this._end        = fs.statSync(filePath).size
        this._recordSize = recordSize

        const cap = Math.max(1, Math.floor(IO_CHUNK_BYTES / recordSize))
        this._buf     = Buffer.alloc(cap * recordSize)
        this._bufLen  = 0
        this._bufOff  = 0
        this._closed  = false
    }

    _refill() {
        if (this._closed || this._pos >= this._end) {
            this._bufLen = 0
            this._bufOff = 0
            return false
        }
        const want = Math.min(this._buf.length, this._end - this._pos)
        let read = 0
        while (read < want) {
            const n = fs.readSync(this._fd, this._buf, read, want - read, this._pos + read)
            if (n === 0) throw new Error(`short read at ${this._pos + read}`)
            read += n
        }
        this._pos   += want
        this._bufLen = want
        this._bufOff = 0
        return true
    }

    /**
     * @returns {Buffer|null} a VIEW of the next record (invalidated on next
     *                        call), or null on EOF.
     */
    next() {
        if (this._bufOff >= this._bufLen) {
            if (!this._refill()) return null
        }
        const view = this._buf.subarray(this._bufOff, this._bufOff + this._recordSize)
        this._bufOff += this._recordSize
        return view
    }

    close() {
        if (this._closed) return
        this._closed = true
        try { fs.closeSync(this._fd) } catch (_) {}
    }
}

/**
 * Buffered writer for fixed-size records. Has no header logic; the caller
 * writes the header (if any) via `writeRaw` before any records.
 */
class RecordWriter {
    constructor(filePath, recordSize) {
        this._fd         = fs.openSync(filePath, 'w')
        this._recordSize = recordSize
        const cap = Math.max(1, Math.floor(IO_CHUNK_BYTES / recordSize))
        this._buf    = Buffer.alloc(cap * recordSize)
        this._bufLen = 0
        this._closed = false
    }

    writeRaw(bytes) {
        this.flush()
        fs.writeSync(this._fd, bytes, 0, bytes.length)
    }

    writeRecord(record) {
        record.copy(this._buf, this._bufLen * this._recordSize)
        this._bufLen++
        if (this._bufLen === Math.floor(this._buf.length / this._recordSize)) this.flush()
    }

    flush() {
        if (this._bufLen === 0) return
        fs.writeSync(this._fd, this._buf, 0, this._bufLen * this._recordSize)
        this._bufLen = 0
    }

    close() {
        if (this._closed) return
        this._closed = true
        this.flush()
        try { fs.closeSync(this._fd) } catch (_) {}
    }
}

function readHeaderBytes(filePath, headerSize) {
    if (headerSize === 0) return Buffer.alloc(0)
    const fd  = fs.openSync(filePath, 'r')
    const buf = Buffer.alloc(headerSize)
    try {
        let read = 0
        while (read < headerSize) {
            const n = fs.readSync(fd, buf, read, headerSize - read, read)
            if (n === 0) throw new Error('short header read')
            read += n
        }
    } finally {
        fs.closeSync(fd)
    }
    return buf
}

/**
 * Left-anti-join: emit LEFT records whose key does not appear in RIGHT.
 *
 * @param {Object}  opts
 * @param {string}  opts.leftPath         sorted fixed-record file, has the data rows
 * @param {string}  opts.rightPath        sorted fixed-record file, cancellation keys
 * @param {string}  opts.outputPath       emit destination
 * @param {number}  opts.leftHeaderSize   default 0
 * @param {number}  opts.leftRecordSize
 * @param {number}  opts.rightHeaderSize  default 0
 * @param {number}  opts.rightRecordSize
 * @param {number}  opts.keySize          first-N-bytes of each record, same on both sides
 * @param {boolean} opts.copyLeftHeader   if true, left's first headerSize bytes are
 *                                        written verbatim to the output
 * @param {Function} opts.onProgress      callback({phase, ...})
 * @param {Function} opts.onAnomaly       callback({type, key, ...}) for orphan
 *                                        spends / duplicate keys
 *
 * @returns {Promise<{
 *   leftRead:number, rightRead:number, emitted:number,
 *   canceled:number, orphanSpends:number,
 * }>}
 */
async function leftAntiJoin(opts) {
    const {
        leftPath, rightPath, outputPath,
        leftRecordSize, rightRecordSize, keySize,
    } = opts
    const leftHeaderSize  = opts.leftHeaderSize  || 0
    const rightHeaderSize = opts.rightHeaderSize || 0
    const copyLeftHeader  = !!opts.copyLeftHeader
    const onProgress      = opts.onProgress      || noop
    const onAnomaly       = opts.onAnomaly       || noop

    if (!leftPath || !rightPath || !outputPath) {
        throw new Error('leftAntiJoin: leftPath, rightPath, outputPath are required')
    }
    if (!Number.isInteger(keySize) || keySize <= 0) {
        throw new Error('leftAntiJoin: keySize must be a positive integer')
    }
    if (keySize > leftRecordSize || keySize > rightRecordSize) {
        throw new Error('leftAntiJoin: keySize exceeds one of the record sizes')
    }

    const left  = new RecordReader(leftPath,  leftHeaderSize,  leftRecordSize)
    const right = new RecordReader(rightPath, rightHeaderSize, rightRecordSize)
    const out   = new RecordWriter(outputPath, leftRecordSize)

    let leftRead     = 0
    let rightRead    = 0
    let emitted      = 0
    let canceled     = 0
    let orphanSpends = 0

    try {
        if (copyLeftHeader && leftHeaderSize > 0) {
            out.writeRaw(readHeaderBytes(leftPath, leftHeaderSize))
        }

        let leftCurr  = left.next();  if (leftCurr)  leftRead++
        let rightCurr = right.next(); if (rightCurr) rightRead++

        while (leftCurr) {
            if (!rightCurr) {
                out.writeRecord(leftCurr)
                emitted++
                leftCurr = left.next(); if (leftCurr) leftRead++
                continue
            }
            const cmp = Buffer.compare(
                leftCurr.subarray(0, keySize),
                rightCurr.subarray(0, keySize),
            )
            if (cmp < 0) {
                out.writeRecord(leftCurr)
                emitted++
                leftCurr = left.next(); if (leftCurr) leftRead++
            } else if (cmp > 0) {
                orphanSpends++
                onAnomaly({ type: 'orphan-spend', key: Buffer.from(rightCurr.subarray(0, keySize)) })
                rightCurr = right.next(); if (rightCurr) rightRead++
            } else {
                canceled++
                leftCurr  = left.next();  if (leftCurr)  leftRead++
                rightCurr = right.next(); if (rightCurr) rightRead++
            }
        }

        // Drain any remaining right records; all are orphan spends.
        while (rightCurr) {
            orphanSpends++
            onAnomaly({ type: 'orphan-spend', key: Buffer.from(rightCurr.subarray(0, keySize)) })
            rightCurr = right.next(); if (rightCurr) rightRead++
        }
    } finally {
        left.close()
        right.close()
        out.close()
    }

    onProgress({
        phase: 'done',
        leftRead, rightRead, emitted, canceled, orphanSpends,
    })

    return { leftRead, rightRead, emitted, canceled, orphanSpends }
}

module.exports = { leftAntiJoin, RecordReader, RecordWriter }
