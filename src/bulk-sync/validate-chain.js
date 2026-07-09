#!/usr/bin/env node
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
 * XChain UTXO Tracker - Bulk Sync Chain-Continuity Validator
 *
 * Defense-in-depth for a bootstrap dump. dump.js records the node-provided
 * block hash in each .xdmp record header but never recomputes it, and the
 * pipeline never checks that consecutive blocks actually link. orderBatchResults
 * (BlockchainConnector) guarantees the right block hex maps to the right height
 * WITHIN a batch RPC, but a Byzantine/buggy node returning valid-looking-but-
 * wrong block bytes, or on-disk .xdmp corruption, would still silently poison a
 * bootstrap. This pass closes that gap: for every block it recomputes the
 * canonical id (sha256d over the 80-byte header - correct for BTC, LTC scrypt,
 * and DOGE AuxPoW alike, since the block id is always header-based) and confirms
 * it equals the stored hash, then confirms each header's prevHash links to the
 * previous height's block hash across the whole contiguous dump.
 *
 * Read-only: opens the .xdmp files, computes hashes, reports. It mutates nothing
 * and is safe to run against a live dump directory before the parse phase.
 *
 ********************************************************************/

const crypto = require('crypto')
const fs     = require('fs')
const path   = require('path')
const { XdmpReader } = require('./xdmp-reader.js')

const ZERO32       = Buffer.alloc(32, 0)
const HEADER_BYTES = 80         // version(4) prevHash(32) merkleRoot(32) time(4) bits(4) nonce(4)
const PREV_OFF     = 4          // prevHash field offset inside the 80-byte header

function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest()
}

// Bitcoin's double-SHA256. The block id is the reverse (display order) of this
// over the 80-byte header.
function hash256(buf) {
    return sha256(sha256(buf))
}

function reverse32(src) {
    const out = Buffer.alloc(32)
    for (let i = 0; i < 32; i++) out[i] = src[31 - i]
    return out
}

/**
 * Core check, factored out of file I/O so it is unit-testable with hand-built
 * blocks. Consumes an iterable of { height, blockHash, blockBytes } in ascending
 * height order (as XdmpReader.blocks() yields). blockBytes may be a scratch view
 * that the producer invalidates on the next step, so every read happens before
 * the iterator advances.
 *
 * @returns {{ ok:boolean, blocksChecked:number, firstHeight:(number|null),
 *             lastHeight:(number|null), error:(string|null) }}
 */
function verifyBlockSequence(blocks) {
    let blocksChecked = 0
    let firstHeight   = null
    let lastHeight    = null
    let prevHeight    = null
    let prevHash      = null    // display-order block hash of the previous block

    for (const { height, blockHash, blockBytes } of blocks) {
        if (!Buffer.isBuffer(blockBytes) || blockBytes.length < HEADER_BYTES) {
            return fail(height, `block too short to hold an 80-byte header (${blockBytes ? blockBytes.length : 0}B)`)
        }
        if (!Buffer.isBuffer(blockHash) || blockHash.length !== 32) {
            return fail(height, 'record blockHash is not a 32-byte buffer')
        }

        const header   = blockBytes.slice(0, HEADER_BYTES)
        const computed = reverse32(hash256(header))
        if (!computed.equals(blockHash)) {
            return fail(height,
                `block hash mismatch: record=${blockHash.toString('hex')} recomputed=${computed.toString('hex')}`)
        }

        const headerPrev = reverse32(header.slice(PREV_OFF, PREV_OFF + 32))

        if (prevHash === null) {
            // First block of the dump.
            if (height === 0 && !headerPrev.equals(ZERO32)) {
                return fail(height, `genesis prevHash is not zero: ${headerPrev.toString('hex')}`)
            }
            // A dump that starts above 0 has no in-dump predecessor to link to,
            // so the backward link is unverifiable for this one block; the hash
            // recompute above still validates it.
            firstHeight = height
        } else {
            if (height !== prevHeight + 1) {
                return fail(height, `height gap: previous was ${prevHeight}`)
            }
            if (!headerPrev.equals(prevHash)) {
                return fail(height,
                    `prevHash link broken: header.prev=${headerPrev.toString('hex')} expected=${prevHash.toString('hex')}`)
            }
        }

        prevHeight = height
        prevHash   = blockHash
        lastHeight = height
        blocksChecked++
    }

    return { ok: true, blocksChecked, firstHeight, lastHeight, error: null }

    function fail(height, msg) {
        return { ok: false, blocksChecked, firstHeight, lastHeight, error: `height ${height}: ${msg}` }
    }
}

// Peek a file's dump range without holding the fd open for the whole walk.
function readRange(file) {
    const r = new XdmpReader(file)
    const range = { file, firstHeight: r.firstHeight, lastHeight: r.lastHeight }
    r.close()
    return range
}

/**
 * Validate that a set of .xdmp files form one contiguous, hash-consistent chain.
 * Files are ordered by their dump firstHeight (filename order is lexical and
 * misorders unpadded ranges, e.g. 10000 sorts before 9999), then walked as one
 * stream. Cross-file gaps/overlaps are rejected before hashing.
 */
function validateChainFiles(files) {
    if (!files || files.length === 0) {
        return { ok: false, blocksChecked: 0, firstHeight: null, lastHeight: null, error: 'no .xdmp files given' }
    }

    const ranges = files.map(readRange).sort((a, b) => a.firstHeight - b.firstHeight)
    for (let i = 1; i < ranges.length; i++) {
        const expected = ranges[i - 1].lastHeight + 1
        if (ranges[i].firstHeight !== expected) {
            return {
                ok: false, blocksChecked: 0, firstHeight: ranges[0].firstHeight, lastHeight: null,
                error: `dump files are not contiguous: ${path.basename(ranges[i].file)} starts at ${ranges[i].firstHeight}, expected ${expected}`
            }
        }
    }

    const readers = []
    try {
        function* allBlocks() {
            for (const { file } of ranges) {
                const reader = new XdmpReader(file)
                readers.push(reader)
                yield* reader.blocks()
            }
        }
        return verifyBlockSequence(allBlocks())
    } catch (err) {
        // A reader throws on a bad magic/version/short-read/height-gap; surface it
        // as a validation failure rather than an unhandled crash.
        return { ok: false, blocksChecked: 0, firstHeight: null, lastHeight: null, error: err.message }
    } finally {
        for (const r of readers) r.close()
    }
}

function findXdmpFiles(dir) {
    return fs.readdirSync(dir)
        .filter(f => f.startsWith('blocks-') && f.endsWith('.xdmp'))
        .map(f => path.join(dir, f))
}

function printHelp() {
    console.log(`Usage: node src/bulk-sync/validate-chain.js [options]

Verifies a bulk-sync dump forms one contiguous, hash-consistent block chain:
each record's stored hash is recomputed from its 80-byte header, and each
header's prevHash links to the previous height's block hash.

Options:
  --dumps <dir>        Directory of blocks-*.xdmp files (required unless --file)
  --file <path>        A single .xdmp file (repeatable); overrides --dumps
  --from <n>           Assert the dump starts at this height
  --to <n>             Assert the dump ends at this height
  -h, --help           Show this help

Exit codes: 0 = chain OK, 2 = chain broken, 1 = fatal/bad usage.

Examples:
  node src/bulk-sync/validate-chain.js --dumps /data/dumps
  node src/bulk-sync/validate-chain.js --file a.xdmp --file b.xdmp --from 0
`)
}

function parseArgs(argv) {
    const args = { files: [] }
    for (let i = 2; i < argv.length; i++) {
        switch (argv[i]) {
            case '--dumps':  args.dumps = argv[++i]; break
            case '--file':   args.files.push(argv[++i]); break
            case '--from':   args.from = parseInt(argv[++i], 10); break
            case '--to':     args.to = parseInt(argv[++i], 10); break
            case '-h':
            case '--help':   printHelp(); process.exit(0)
            default: throw new Error('Unknown argument: ' + argv[i])
        }
    }
    return args
}

function main() {
    const args = parseArgs(process.argv)
    let files = args.files
    if (files.length === 0) {
        if (!args.dumps) throw new Error('--dumps <dir> or --file <path> is required')
        files = findXdmpFiles(args.dumps)
        if (files.length === 0) throw new Error(`no blocks-*.xdmp files in ${args.dumps}`)
    }

    console.log(`[validate-chain] checking ${files.length} .xdmp file(s)`)
    const startedAt = Date.now()
    const res = validateChainFiles(files)
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)

    if (!res.ok) {
        console.log(`[validate-chain] RESULT: BROKEN after ${res.blocksChecked} block(s) in ${elapsed}s`)
        console.log(`[validate-chain] ${res.error}`)
        process.exit(2)
    }

    // Optional bound assertions.
    if (args.from != null && res.firstHeight !== args.from) {
        console.log(`[validate-chain] RESULT: BOUND MISMATCH - firstHeight ${res.firstHeight}, expected --from ${args.from}`)
        process.exit(2)
    }
    if (args.to != null && res.lastHeight !== args.to) {
        console.log(`[validate-chain] RESULT: BOUND MISMATCH - lastHeight ${res.lastHeight}, expected --to ${args.to}`)
        process.exit(2)
    }

    console.log(`[validate-chain] RESULT: OK - ${res.blocksChecked} blocks, heights ${res.firstHeight}..${res.lastHeight}, ${elapsed}s`)
    process.exit(0)
}

if (require.main === module) {
    try {
        main()
    } catch (err) {
        console.error('[validate-chain] FATAL:', err.message)
        process.exit(1)
    }
}

module.exports = { verifyBlockSequence, validateChainFiles, findXdmpFiles }
