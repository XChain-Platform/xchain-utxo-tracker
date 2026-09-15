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
 **********************************************************************/

const fs             = require('fs')
const path           = require('path')
const { OUTPUTS_RECORD_SIZE } = require('../writers.js')

// helpers

function fmtDuration(ms) {
    const s = Math.floor(ms / 1000)
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = s % 60
    return `${String(h).padStart(2, '0')}h${String(m).padStart(2, '0')}m${String(sec).padStart(2, '0')}s`
}

/**
 * Concatenate multiple binary files into one, keeping the header from the
 * first file and stripping it from subsequent files. Downstream readers
 * (RecordReader, MetaReader, deriveKeys) expect a single header.
 *
 * After concatenation, patches the output header so its record_count (offset
 * 20, u64 LE) equals the sum of record_count across inputs, and its
 * lastHeight (offset 16, u32 LE) equals the max across inputs. Without this
 * MetaReader rejects the concatenated file when it contains records from
 * more than one input.
 *
 * Returns total bytes written (including the one header).
 */
function concatFilesWithHeader(inputPaths, outputPath, headerSize) {
    if (inputPaths.length === 0) throw new Error('concatFilesWithHeader: no input files')

    const hdrBuf = Buffer.alloc(headerSize)
    let totalRecordCount = 0n
    let maxLastHeight = 0
    let firstHdr = null       // magic/chain/net/record_size of the first input
    let prevLastHeight = null // cross-file contiguity check

    // Write to a .tmp and rename only after the header patch, so a crashed
    // concat can never satisfy phaseMerge's existence-based resume guard with
    // a half-written (or first-input-header-only) file.
    const tmpPath = outputPath + '.tmp'
    const fd = fs.openSync(tmpPath, 'w+')
    const BUF_SIZE = 256 * 1024
    const buf = Buffer.alloc(BUF_SIZE)
    let totalBytes = 0
    try {
        for (let i = 0; i < inputPaths.length; i++) {
            const stat = fs.statSync(inputPaths[i])
            const fdIn = fs.openSync(inputPaths[i], 'r')
            try {
                // Read this input's header to aggregate record_count + lastHeight.
                if (stat.size < headerSize) {
                    throw new Error(`${inputPaths[i]} is smaller than headerSize ${headerSize}`)
                }
                let hRead = 0
                while (hRead < headerSize) {
                    const n = fs.readSync(fdIn, hdrBuf, hRead, headerSize - hRead, hRead)
                    if (n === 0) throw new Error(`short header read in ${inputPaths[i]}`)
                    hRead += n
                }

                // Every input must agree on magic, chain, net and record_size.
                // Mixed record widths (legacy 120B vs coinbase-flagged 121B
                // outputs surviving a resume across a code upgrade) would
                // misframe every record after the first width transition, and
                // the sort's divisibility check cannot always catch it.
                const thisHdr = {
                    magic:      hdrBuf.toString('ascii', 0, 8),
                    chain:      hdrBuf.readUInt8(8),
                    net:        hdrBuf.readUInt8(9),
                    recordSize: hdrBuf.readUInt32LE(28),
                }
                const recordCount = hdrBuf.readBigUInt64LE(20)
                const firstH      = hdrBuf.readUInt32LE(12)
                const lastH       = hdrBuf.readUInt32LE(16)
                if (recordCount === 0n && stat.size !== headerSize) {
                    // SPEC: count 0 marks a crashed/partial worker file (data
                    // present, backfill never ran). A header-only file with
                    // count 0 is a legitimately empty stream (e.g. a spends
                    // range with no non-coinbase inputs).
                    throw new Error(`${inputPaths[i]} has record_count 0 but ${stat.size} bytes (crashed/partial worker output); re-run the parse for this range`)
                }
                if (firstHdr === null) {
                    firstHdr = thisHdr
                } else {
                    for (const f of ['magic', 'chain', 'net', 'recordSize']) {
                        if (thisHdr[f] !== firstHdr[f]) {
                            throw new Error(`${inputPaths[i]} header ${f}=${thisHdr[f]} differs from first input's ${firstHdr[f]}; refusing to concatenate mixed files`)
                        }
                    }
                    if (prevLastHeight !== null && firstH !== prevLastHeight + 1) {
                        throw new Error(`${inputPaths[i]} starts at height ${firstH}, expected ${prevLastHeight + 1} (gap or overlap in parsed ranges)`)
                    }
                }
                prevLastHeight = lastH

                totalRecordCount += recordCount
                if (lastH > maxLastHeight) maxLastHeight = lastH

                // First file: copy entirely. Others: skip header.
                let pos = (i === 0) ? 0 : headerSize
                while (pos < stat.size) {
                    const toRead = Math.min(BUF_SIZE, stat.size - pos)
                    const n = fs.readSync(fdIn, buf, 0, toRead, pos)
                    if (n === 0) throw new Error(`short read in ${inputPaths[i]} at offset ${pos} (file shrank mid-copy?)`)
                    fs.writeSync(fd, buf, 0, n)
                    totalBytes += n
                    pos += n
                }
                if (pos !== stat.size) {
                    throw new Error(`${inputPaths[i]}: copied ${pos} of ${stat.size} bytes`)
                }
            } finally {
                fs.closeSync(fdIn)
            }
        }

        // Patch aggregated record_count (offset 20, u64 LE) and lastHeight
        // (offset 16, u32 LE) into the output header.
        const patch = Buffer.alloc(8)
        patch.writeUInt32LE(maxLastHeight, 0)
        fs.writeSync(fd, patch, 0, 4, 16)
        patch.writeBigUInt64LE(totalRecordCount, 0)
        fs.writeSync(fd, patch, 0, 8, 20)
        fs.fsyncSync(fd)
    } catch (err) {
        try { fs.closeSync(fd) } catch (_) {}
        try { fs.unlinkSync(tmpPath) } catch (_) {}
        throw err
    }
    fs.closeSync(fd)
    fs.renameSync(tmpPath, outputPath)
    return totalBytes
}

/**
 * Read the record_size field (offset 28, u32 LE) from a dump/intermediate
 * header. This is the explicit width discriminator between the legacy 120-byte
 * outputs record and the 121-byte coinbase-flagged record. Falls back to
 * the compiled OUTPUTS_RECORD_SIZE if the field is absent (0) or unreadable, so
 * a pre-record_size dump still parses at the current width.
 */
function readOutputsRecordSize(filePath) {
    let fd
    try {
        fd = fs.openSync(filePath, 'r')
        const buf = Buffer.alloc(4)
        const n = fs.readSync(fd, buf, 0, 4, 28)
        if (n < 4) return OUTPUTS_RECORD_SIZE
        const rs = buf.readUInt32LE(0)
        return rs > 0 ? rs : OUTPUTS_RECORD_SIZE
    } catch (_) {
        return OUTPUTS_RECORD_SIZE
    } finally {
        if (fd !== undefined) { try { fs.closeSync(fd) } catch (_) {} }
    }
}

/**
 * Find files matching a glob-like prefix+suffix in a directory.
 * Returns paths sorted by name (which sorts by height range).
 */
function findFiles(dir, prefix, suffix) {
    return fs.readdirSync(dir)
        .filter(f => f.startsWith(prefix) && f.endsWith(suffix))
        .sort()
        .map(f => path.join(dir, f))
}

module.exports = { fmtDuration, concatFilesWithHeader, readOutputsRecordSize, findFiles }
