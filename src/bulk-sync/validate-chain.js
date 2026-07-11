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
 * WITHIN a batch RPC, but a Byzantine/buggy node returning a wrong HEADER, or
 * header-level .xdmp corruption, would still silently poison a bootstrap. This
 * pass closes the header half of that gap: for every block it recomputes the
 * canonical id (sha256d over the 80-byte header - correct for BTC, LTC scrypt,
 * and DOGE AuxPoW alike, since the block id is always header-based) and confirms
 * it equals the stored hash, then confirms each header's prevHash links to the
 * previous height's block hash across the whole contiguous dump.
 *
 * With --merkle the tx bytes are verified too: every tx in each block is
 * parsed (via XChainBlockDecoder, so Litecoin HogEx/MWEB stripping matches
 * the parse phase), its txid recomputed, and the merkle root rebuilt and
 * compared against the header. This closes the body half of the gap: a
 * substituted tx list under a genuine header now fails loudly. The rebuild
 * also rejects CVE-2012-2459 duplicate-pair mutations (two different tx
 * lists that hash to the same root). Litecoin MWEB txs live outside the
 * merkle tree by design (only the HogEx integration tx is committed), so a
 * lying node could still add/remove pure-MWEB data; bulk-sync never reads
 * MWEB payloads, so that residual cannot affect the built DB.
 *
 * Without --merkle only the 80-byte header is hashed (header-chain
 * integrity, not block-body integrity), matching the live tracker's trust
 * model.
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

const MERKLE_OFF = 36           // merkleRoot field offset inside the 80-byte header

/**
 * Rebuild a bitcoin merkle root from txids (internal byte order, as
 * Transaction.getHash() returns them). Returns { root, mutated }: `mutated`
 * flags the CVE-2012-2459 ambiguity (two identical hashes paired at any
 * level), where distinct tx lists produce the same root. Self-duplication of
 * an odd trailing element is the normal rule and does NOT set the flag; only
 * a genuine adjacent-equal pair does (mirrors Bitcoin Core's mutation check).
 */
function computeMerkleRoot(txHashes) {
    let mutated = false
    let level = txHashes
    while (level.length > 1) {
        const next = []
        for (let i = 0; i < level.length; i += 2) {
            const left  = level[i]
            const right = (i + 1 < level.length) ? level[i + 1] : left
            if (i + 1 < level.length && left.equals(right)) mutated = true
            next.push(hash256(Buffer.concat([left, right])))
        }
        level = next
    }
    return { root: level[0], mutated }
}

/**
 * Verify a block's tx section against its header merkle root. blockBytes is
 * header + tx data as stored in the .xdmp (AuxPoW already stripped at dump
 * time). Decoding goes through XChainBlockDecoder so Litecoin HogEx/MWEB
 * handling is byte-identical to the parse phase: after its marker/flag strip
 * getHash() yields the true txid (marker/flag and MWEB payload are excluded
 * from txids the same way segwit witnesses are).
 * Returns null on success, an error string on failure.
 */
function verifyMerkleRoot(blockBytes, decoder) {
    let transactions
    try {
        const block = decoder.blockFromBuffer(blockBytes)
        transactions = block.transactions || []
    } catch (err) {
        return `tx section failed to parse: ${err.message}`
    }
    if (transactions.length === 0) {
        return 'block has no transactions (a real block always has a coinbase)'
    }
    const txids = transactions.map(tx => tx.getHash(false))
    const { root, mutated } = computeMerkleRoot(txids)
    if (mutated) {
        return 'duplicate-pair merkle mutation detected (CVE-2012-2459); tx list is ambiguous'
    }
    const headerRoot = blockBytes.slice(MERKLE_OFF, MERKLE_OFF + 32)
    if (!root.equals(headerRoot)) {
        return `merkle root mismatch: header=${reverse32(headerRoot).toString('hex')} recomputed=${reverse32(root).toString('hex')}`
    }
    return null
}

/**
 * Core check, factored out of file I/O so it is unit-testable with hand-built
 * blocks. Consumes an iterable of { height, blockHash, blockBytes } in ascending
 * height order (as XdmpReader.blocks() yields). blockBytes may be a scratch view
 * that the producer invalidates on the next step, so every read happens before
 * the iterator advances.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.merkle]  also rebuild each block's merkle root from
 *                                 its tx bytes and compare to the header
 * @param {string}  [opts.coin]    coin name for the tx decoder ('bitcoin',
 *                                 'litecoin', 'dogecoin'); required with merkle
 * @returns {{ ok:boolean, blocksChecked:number, firstHeight:(number|null),
 *             lastHeight:(number|null), error:(string|null) }}
 */
function verifyBlockSequence(blocks, opts = {}) {
    let decoder = null
    if (opts.merkle) {
        if (!opts.coin) throw new Error('verifyBlockSequence: opts.coin is required when opts.merkle is set')
        // Lazy require so --help and header-only runs work without bitcoinjs-lib.
        const XChainBlockDecoder = require('../XChainBlockDecoder.js')
        decoder = new XChainBlockDecoder(`${opts.coin}-any`)
    }
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

        if (decoder) {
            const merkleErr = verifyMerkleRoot(blockBytes, decoder)
            if (merkleErr) return fail(height, merkleErr)
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
    const range = { file, firstHeight: r.firstHeight, lastHeight: r.lastHeight, chain: r.chain }
    r.close()
    return range
}

/**
 * Validate that a set of .xdmp files form one contiguous, hash-consistent chain.
 * Files are ordered by their dump firstHeight (filename order is lexical and
 * misorders unpadded ranges, e.g. 10000 sorts before 9999), then walked as one
 * stream. Cross-file gaps/overlaps are rejected before hashing.
 *
 * opts.merkle additionally rebuilds every block's merkle root from its tx
 * bytes; the coin is taken from the dump header (opts.coin overrides).
 */
function validateChainFiles(files, opts = {}) {
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
        const coin = opts.coin || ranges[0].chain
        return verifyBlockSequence(allBlocks(), { merkle: !!opts.merkle, coin })
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
  --merkle             Also rebuild every block's merkle root from its tx bytes
                       and compare to the header (full block-body integrity;
                       slower: parses every transaction)
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
            case '--merkle': args.merkle = true; break
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

    console.log(`[validate-chain] checking ${files.length} .xdmp file(s)${args.merkle ? ' (headers + merkle roots)' : ' (headers only)'}`)
    const startedAt = Date.now()
    const res = validateChainFiles(files, { merkle: args.merkle })
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

module.exports = { verifyBlockSequence, validateChainFiles, findXdmpFiles, computeMerkleRoot, verifyMerkleRoot }
