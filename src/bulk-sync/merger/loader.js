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
const { encodeOutput } = require('../../LevelUpDb.js')

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
const PREFIX_FILES = ['B', 'H', 'I', 'J', 'N', 'O', 'S', 'T', 'Z']

function noop() {}

function openDb(dbPath) {
    const { ClassicLevel } = require('classic-level')
    // Match LevelUpDb.js: open with buffer encodings so Buffer keys/values
    // pass through db.batch() verbatim.
    return new ClassicLevel(dbPath, { keyEncoding: 'buffer', valueEncoding: 'buffer' })
}

async function loadPrefixFile(db, filePath, keySize, recordSize, batchSize, valueTransform) {
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
        for (const pfx of prefixes) {
            const { keySize, recordSize } = LAYOUT[pfx]
            const filePath = path.join(keysDir, pfx + '.dat')
            if (!fs.existsSync(filePath)) {
                onProgress({ phase: 'skip', prefix: pfx, reason: 'file missing' })
                stats[pfx] = 0
                continue
            }
            const t0 = Date.now()
            const valueTransform = (pfx === 'O') ? transformOValue : null
            const count = await loadPrefixFile(db, filePath, keySize, recordSize, batchSize, valueTransform)
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
