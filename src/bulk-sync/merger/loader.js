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
 * XChain UTXO Tracker - Bulk Sync Loader
 *
 * Streams the per-prefix fixed-record files produced by derive-keys.js
 * into a classic-level (LevelDB) DB via db.batch() writes.
 *
 * Each .dat file is a flat concatenation of (key || value) records of a
 * fixed size; we chunk them into batches of `batchSize` records and issue
 * one put-batch per chunk.
 *
 * LAST_* markers are written as Buffer-encoded entries to match
 * LevelUpDb's schema: key = 'LAST_BLOCK_HEIGHT'/'LAST_BLOCK_HASH' (UTF-8
 * bytes), value = hex-string / hash-string bytes. These keys are NOT in any
 * .dat file; they are read from L.json.
 *
 ********************************************************************/

const fs   = require('fs')
const path = require('path')

const { LAYOUT }       = require('./derive-keys.js')
const { RecordReader } = require('./streaming-join.js')
const { encodeOutput, kOutBlk } = require('../../LevelUpDb.js')

// The intermediate O.dat value is fixed-width (value8 + height4 + fullTxHash32 +
// coinbase1 = 45B) so the external sort can treat it as a plain record. On the
// way into LevelDB we collapse it to the live path's exact bytes via
// encodeOutput: a normal output stays 44 bytes, a coinbase output keeps its
// optional 45th flag byte (L-4). This keeps bulk-seeded O-records byte-identical
// to incrementally-indexed ones, so maturity gating reads the flag the same way.
function transformOValue(value) {
    const sat        = value.readBigUInt64BE(0)
    const height     = value.readInt32BE(8)
    const fullTxHash = value.subarray(12, 44).toString('hex')
    const isCoinbase = value.length > 44 && value[44] === 1
    return encodeOutput(sat, height, fullTxHash, isCoinbase)
}

// File name → prefix letter. Load order doesn't affect correctness for
// LevelDB (keys end up sorted internally). We go alphabetical which is
// also ascending prefix-byte order.
const PREFIX_FILES = ['B', 'H', 'I', 'J', 'N', 'O', 'S', 'T', 'W', 'Z']

// Parity guard for the W (creation-block reverse index) prefix. Byte-exactness
// across the whole merger pipeline is the hazard: a W key the live unwind can't
// match silently re-introduces the phantom-UTXO corruption the index exists to
// prevent. For every seeded W record we decompose the key, rebuild it through
// the live insertOutputBlock key-builder (LevelUpDb.kOutBlk), and assert the
// rebuilt key is byte-identical to what derive-keys emitted, plus that the value
// is the 32-byte scriptPubKey the live path stores. A single mismatch aborts the
// load rather than shipping a subtly-wrong reorg window.
function validateWRecord(key, value) {
    if (key.length !== 45) {
        throw new Error(`loadKeys: W key must be 45 bytes, got ${key.length}`)
    }
    if (value.length !== 32) {
        throw new Error(`loadKeys: W value (scriptPubKey) must be 32 bytes, got ${value.length}`)
    }
    const blockHashHex = key.subarray(1, 33).toString('hex')
    const txHash8Hex   = key.subarray(33, 41).toString('hex')
    const idx          = key.readUInt32BE(41)
    const liveKey      = kOutBlk(blockHashHex, txHash8Hex, idx)
    if (!liveKey.equals(key)) {
        throw new Error(`loadKeys: W key mismatch vs live insertOutputBlock encoding at block ${blockHashHex} tx ${txHash8Hex} idx ${idx}`)
    }
}

function noop() {}

function openDb(dbPath) {
    const { ClassicLevel } = require('classic-level')
    // Match LevelUpDb.js: open with buffer encodings so Buffer keys/values
    // pass through db.batch() verbatim.
    return new ClassicLevel(dbPath, { keyEncoding: 'buffer', valueEncoding: 'buffer' })
}

async function loadPrefixFile(db, filePath, keySize, recordSize, batchSize, valueTransform, recordValidator) {
    const reader = new RecordReader(filePath, 0, recordSize)
    let total = 0
    let ops   = []

    try {
        while (true) {
            const rec = reader.next()
            if (!rec) break
            // Buffer.from copies; views are invalidated on next read.
            const key   = Buffer.from(rec.subarray(0, keySize))
            let   value = Buffer.from(rec.subarray(keySize, recordSize))
            if (recordValidator) recordValidator(key, value)
            if (valueTransform) value = valueTransform(value)
            ops.push({ type: 'put', key, value })
            total++
            if (ops.length >= batchSize) {
                await db.batch(ops)
                ops = []
            }
        }
        if (ops.length > 0) await db.batch(ops)
    } finally {
        reader.close()
    }
    return total
}

/**
 * @param {Object}  opts
 * @param {string}  opts.keysDir      directory with B.dat..Z.dat + L.json
 * @param {string}  opts.dbPath       DB directory path (classic-level / LevelDB)
 * @param {number}  opts.batchSize    records per batch (default 10000)
 * @param {boolean} opts.removeSpent  skip T/I/J prefixes. Matches
 *                                     XChainUtxoTracker.REMOVE_SPENT: when
 *                                     true, live code never persists T/I/J so
 *                                     loading them wastes disk for records
 *                                     nobody reads. Default false.
 * @param {Function} opts.onProgress  ({phase, ...})
 */
async function loadKeys(opts) {
    const { keysDir, dbPath } = opts
    const batchSize   = opts.batchSize  || 10000
    const removeSpent = Boolean(opts.removeSpent)
    const onProgress  = opts.onProgress || noop

    if (!keysDir || !dbPath) {
        throw new Error('loadKeys: keysDir, dbPath are required')
    }

    const db = openDb(dbPath)
    await db.open()

    const prefixes = removeSpent
        ? PREFIX_FILES.filter(p => p !== 'T' && p !== 'I' && p !== 'J')
        : PREFIX_FILES

    const stats = {}
    const startedAt = Date.now()

    try {
        // A bulk load must start from an empty store. The loop below only puts
        // records and never deletes a key the seed no longer carries, and the
        // LAST_* markers are written last, so seeding a populated DB overlays
        // the new seed on the old records and then advertises the mixture as
        // fully synced. The reachable trigger is api.js runBulkSyncIfEmpty:
        // isDbEmpty() reads LAST_BLOCK_HEIGHT, so a load that crashed before
        // the markers looks empty on the next boot and reseeds on top of its
        // own partial write (). Refuse loudly instead of serving
        // stale or phantom UTXOs.
        const existing = await db.keys({ limit: 1 }).all()
        if (existing.length > 0) {
            throw new Error(`loadKeys: target DB at ${dbPath} is not empty; a bulk load requires a fresh, empty dbPath (remove the directory, or point --out at an empty path, before re-running)`)
        }

        for (const pfx of prefixes) {
            const { keySize, recordSize } = LAYOUT[pfx]
            const filePath = path.join(keysDir, pfx + '.dat')
            if (!fs.existsSync(filePath)) {
                // Every selected prefix file is produced by a completed
                // deriveKeys run. A missing one means a partial derive; a
                // silent skip would still write LAST_* markers below and
                // produce a DB that claims full sync with missing records.
                throw new Error(`loadKeys: missing ${pfx}.dat in ${keysDir} (partial derive-keys output; re-run derive)`)
            }
            const t0 = Date.now()
            const valueTransform  = (pfx === 'O') ? transformOValue : null
            const recordValidator = (pfx === 'W') ? validateWRecord : null
            const count = await loadPrefixFile(db, filePath, keySize, recordSize, batchSize, valueTransform, recordValidator)
            stats[pfx] = count
            onProgress({
                phase: 'prefix-done', prefix: pfx,
                count, elapsed_ms: Date.now() - t0,
            })
        }

        // L markers: string keys, string values (match LevelUpDb schema).
        const lPath = path.join(keysDir, 'L.json')
        if (!fs.existsSync(lPath)) throw new Error(`loadKeys: missing L.json at ${lPath}`)
        const L = JSON.parse(fs.readFileSync(lPath, 'utf8'))
        if (!('LAST_BLOCK_HEIGHT' in L) || !('LAST_BLOCK_HASH' in L)) {
            throw new Error('loadKeys: L.json missing LAST_BLOCK_HEIGHT / LAST_BLOCK_HASH')
        }
        // DB is opened with buffer encodings; store the string metadata keys
        // and values as their UTF-8 byte Buffers (matches LevelUpDb.js).
        await db.batch([
            { type: 'put', key: Buffer.from('LAST_BLOCK_HEIGHT'), value: Buffer.from(L.LAST_BLOCK_HEIGHT) },
            { type: 'put', key: Buffer.from('LAST_BLOCK_HASH'),   value: Buffer.from(L.LAST_BLOCK_HASH)   },
        ])
        stats.L = 2
    } finally {
        await db.close()
    }

    const elapsed = Date.now() - startedAt
    onProgress({ phase: 'done', stats, elapsed_ms: elapsed })
    return { stats, elapsed_ms: elapsed }
}

module.exports = { loadKeys }
