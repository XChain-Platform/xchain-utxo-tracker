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
 * XChain UTXO Tracker - Bulk Sync External Sort
 *
 * Sorts a fixed-record file by the first `keySize` bytes of each record,
 * using bounded RAM. Two phases:
 *
 *   1. Create sorted runs: read chunks of (ramBudgetBytes / recordSize)
 *      records, sort in RAM by Buffer.compare on the key prefix, write to
 *      a temp run file (no header, just records).
 *
 *   2. k-way merge: open all runs, maintain a min-heap of the front record
 *      from each run keyed by the key prefix, emit in order.
 *
 * If `preserveHeader` is true, the first `headerSize` bytes of the input
 * are copied verbatim to the output before records are written.
 *
 ********************************************************************/

const fs   = require('fs')
const path = require('path')

function noop() {}

/**
 * Simple binary min-heap keyed by a Buffer comparator, with an optional
 * numeric `seq` tie-break for equal keys. The tie-break makes the k-way
 * merge deterministic on duplicate keys: runs are created in input order
 * (ascending height) and phase-1's Array.sort is stable, so seq = runIdx
 * yields chronological order for equal keys. Without it, which duplicate
 * (e.g. BIP30 duplicate coinbase txids) the loader's last-write-wins keeps
 * would be heap-shape-dependent, diverging from the live tracker's
 * deterministic "later block wins".
 */
class MinHeap {
    constructor() { this._nodes = [] }
    get size() { return this._nodes.length }

    _less(a, b) {
        const cmp = Buffer.compare(a.key, b.key)
        if (cmp !== 0) return cmp < 0
        return (a.seq || 0) < (b.seq || 0)
    }

    push(key, payload, seq) {
        const nodes = this._nodes
        nodes.push({ key, payload, seq })
        let i = nodes.length - 1
        while (i > 0) {
            const parent = (i - 1) >> 1
            if (this._less(nodes[i], nodes[parent])) {
                const tmp = nodes[i]; nodes[i] = nodes[parent]; nodes[parent] = tmp
                i = parent
            } else break
        }
    }

    pop() {
        const nodes = this._nodes
        if (nodes.length === 0) return undefined
        const top = nodes[0]
        const last = nodes.pop()
        if (nodes.length > 0) {
            nodes[0] = last
            const n = nodes.length
            let i = 0
            while (true) {
                const l = 2 * i + 1
                const r = 2 * i + 2
                let smallest = i
                if (l < n && this._less(nodes[l], nodes[smallest])) smallest = l
                if (r < n && this._less(nodes[r], nodes[smallest])) smallest = r
                if (smallest === i) break
                const tmp = nodes[i]; nodes[i] = nodes[smallest]; nodes[smallest] = tmp
                i = smallest
            }
        }
        return top
    }
}

/**
 * Sort a fixed-record file by its first `keySize` bytes.
 *
 * @param {Object}  opts
 * @param {string}  opts.inputPath        input file (may have a header)
 * @param {string}  opts.outputPath       output file
 * @param {number}  opts.headerSize       bytes to skip at start of input (default 0)
 * @param {number}  opts.recordSize       fixed record size in bytes
 * @param {number}  opts.keySize          sort-key size (prefix of each record)
 * @param {number}  opts.ramBudgetBytes   RAM cap for the sort-run buffer (default 1 GiB)
 * @param {string}  opts.tmpDir           directory for intermediate run files (required)
 * @param {boolean} opts.preserveHeader   copy input header to output (default false)
 * @param {boolean} opts.keepRuns         skip deleting run files (default false)
 * @param {Function} opts.onProgress      optional callback({phase, ...}) for logging
 *
 * @returns {Promise<{runsCreated:number, recordsSorted:number, bytesOut:number}>}
 */
async function externalSort(opts) {
    const {
        inputPath,
        outputPath,
        recordSize,
        keySize,
        tmpDir,
    } = opts
    const headerSize     = opts.headerSize     || 0
    const ramBudgetBytes = opts.ramBudgetBytes || (1024 * 1024 * 1024)
    const preserveHeader = !!opts.preserveHeader
    const keepRuns       = !!opts.keepRuns
    const onProgress     = opts.onProgress     || noop

    if (!inputPath || !outputPath || !tmpDir) {
        throw new Error('externalSort: inputPath, outputPath, tmpDir are required')
    }
    if (!Number.isInteger(recordSize) || recordSize <= 0) {
        throw new Error('externalSort: recordSize must be a positive integer')
    }
    if (!Number.isInteger(keySize) || keySize <= 0 || keySize > recordSize) {
        throw new Error('externalSort: keySize must satisfy 0 < keySize <= recordSize')
    }

    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true })

    const inStat = fs.statSync(inputPath)
    const dataBytes = inStat.size - headerSize
    if (dataBytes < 0 || dataBytes % recordSize !== 0) {
        throw new Error(
            `externalSort: input data (${dataBytes} bytes after header) is not a multiple of recordSize ${recordSize}`
        )
    }
    const totalRecords = dataBytes / recordSize

    // Records per run capped by RAM budget AND by V8's FixedArray limit.
    // `indices` is a plain Array of SMIs; V8 tops out around 2^27 elements
    // for the fast-elements backing store, and Array.prototype.sort with a
    // comparator allocates a temp buffer of similar size. 2^26 (~67M) is a
    // comfortable cap that keeps sort stable without hitting "invalid table
    // size" OOM during resize. This matters most for small records (e.g.
    // 20B spends with a 4 GiB ramBudget → 214M records, which blows up V8).
    const MAX_RECORDS_PER_RUN = 1 << 26
    const recordsPerRun = Math.max(
        1,
        Math.min(
            Math.floor(ramBudgetBytes / recordSize),
            MAX_RECORDS_PER_RUN,
        ),
    )

    onProgress({
        phase: 'start',
        totalRecords, recordsPerRun,
        expectedRuns: Math.ceil(totalRecords / recordsPerRun),
    })

    // ---------- Phase 1: create sorted runs ----------

    const runPaths = []
    const fdIn = fs.openSync(inputPath, 'r')
    try {
        let position = headerSize
        let runIdx   = 0
        const bigBuf = Buffer.alloc(recordsPerRun * recordSize)

        while (position < inStat.size) {
            const remainingBytes = inStat.size - position
            const wantBytes      = Math.min(remainingBytes, bigBuf.length)
            const wantRecords    = wantBytes / recordSize

            // Cap per-syscall read to avoid int32 overflow in Node's fs.readSync length param.
            const SAFE_READ_CHUNK = 1 << 30
            let readSoFar = 0
            while (readSoFar < wantBytes) {
                const reqLen = Math.min(wantBytes - readSoFar, SAFE_READ_CHUNK)
                const n = fs.readSync(fdIn, bigBuf, readSoFar, reqLen, position + readSoFar)
                if (n === 0) throw new Error(`short read at position ${position + readSoFar}`)
                readSoFar += n
            }
            position += wantBytes

            // Sort by first `keySize` bytes via an index array + Buffer.compare.
            const indices = new Array(wantRecords)
            for (let i = 0; i < wantRecords; i++) indices[i] = i
            indices.sort((a, b) => Buffer.compare(
                bigBuf.subarray(a * recordSize, a * recordSize + keySize),
                bigBuf.subarray(b * recordSize, b * recordSize + keySize),
            ))

            const runPath = path.join(tmpDir, `run-${String(runIdx).padStart(5, '0')}.dat`)
            const fdOut = fs.openSync(runPath, 'w')
            try {
                // Write records in sorted order. Reuse a single flush buffer
                // sized to at most ~256 KB to avoid many tiny syscalls.
                const flushCap = Math.max(1, Math.floor((256 * 1024) / recordSize))
                const flushBuf = Buffer.alloc(flushCap * recordSize)
                let flushLen   = 0
                for (let i = 0; i < wantRecords; i++) {
                    const srcOff = indices[i] * recordSize
                    bigBuf.copy(flushBuf, flushLen * recordSize, srcOff, srcOff + recordSize)
                    flushLen++
                    if (flushLen === flushCap) {
                        fs.writeSync(fdOut, flushBuf, 0, flushLen * recordSize)
                        flushLen = 0
                    }
                }
                if (flushLen > 0) fs.writeSync(fdOut, flushBuf, 0, flushLen * recordSize)
            } finally {
                fs.closeSync(fdOut)
            }

            runPaths.push(runPath)
            runIdx++
            onProgress({ phase: 'run', runIdx, records: wantRecords, totalRecords })
        }
    } finally {
        fs.closeSync(fdIn)
    }

    // ---------- Phase 2: k-way merge ----------

    onProgress({ phase: 'merge-start', runs: runPaths.length })

    const fdOut = fs.openSync(outputPath, 'w')
    let bytesOut = 0
    try {
        // Header pass-through.
        if (preserveHeader && headerSize > 0) {
            const hdr = Buffer.alloc(headerSize)
            const fdH = fs.openSync(inputPath, 'r')
            try {
                let read = 0
                while (read < headerSize) {
                    const n = fs.readSync(fdH, hdr, read, headerSize - read, read)
                    if (n === 0) throw new Error('short header read')
                    read += n
                }
            } finally {
                fs.closeSync(fdH)
            }
            fs.writeSync(fdOut, hdr, 0, headerSize)
            bytesOut += headerSize
        }

        // Open all run files, prime the heap with one record from each.
        const runFds  = runPaths.map(p => fs.openSync(p, 'r'))
        const runPos  = new Array(runPaths.length).fill(0)
        const runSize = runPaths.map(p => fs.statSync(p).size)
        const heap    = new MinHeap()

        function readOne(runIdx) {
            if (runPos[runIdx] >= runSize[runIdx]) return null
            const rec = Buffer.alloc(recordSize)
            let readSoFar = 0
            while (readSoFar < recordSize) {
                const n = fs.readSync(runFds[runIdx], rec, readSoFar, recordSize - readSoFar, runPos[runIdx] + readSoFar)
                if (n === 0) throw new Error(`short run read at ${runPos[runIdx]}`)
                readSoFar += n
            }
            runPos[runIdx] += recordSize
            return rec
        }

        try {
            for (let i = 0; i < runPaths.length; i++) {
                const rec = readOne(i)
                if (rec) heap.push(rec.subarray(0, keySize), { runIdx: i, record: rec }, i)
            }

            const flushCap = Math.max(1, Math.floor((256 * 1024) / recordSize))
            const flushBuf = Buffer.alloc(flushCap * recordSize)
            let flushLen   = 0
            let recordsEmitted = 0

            while (heap.size > 0) {
                const { payload } = heap.pop()
                payload.record.copy(flushBuf, flushLen * recordSize)
                flushLen++
                recordsEmitted++
                if (flushLen === flushCap) {
                    fs.writeSync(fdOut, flushBuf, 0, flushLen * recordSize)
                    bytesOut += flushLen * recordSize
                    flushLen = 0
                }
                const nextRec = readOne(payload.runIdx)
                if (nextRec) heap.push(nextRec.subarray(0, keySize), { runIdx: payload.runIdx, record: nextRec }, payload.runIdx)
            }

            if (flushLen > 0) {
                fs.writeSync(fdOut, flushBuf, 0, flushLen * recordSize)
                bytesOut += flushLen * recordSize
            }

            if (recordsEmitted !== totalRecords) {
                throw new Error(`merge emitted ${recordsEmitted} records, expected ${totalRecords}`)
            }
        } finally {
            for (const fd of runFds) { try { fs.closeSync(fd) } catch (_) {} }
        }
    } finally {
        fs.closeSync(fdOut)
    }

    if (!keepRuns) {
        for (const p of runPaths) { try { fs.unlinkSync(p) } catch (_) {} }
    }

    onProgress({ phase: 'done', runs: runPaths.length, totalRecords, bytesOut })
    return { runsCreated: runPaths.length, recordsSorted: totalRecords, bytesOut }
}

module.exports = { externalSort, MinHeap }
