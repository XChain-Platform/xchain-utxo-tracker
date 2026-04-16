'use strict'

/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 *
 **********************************************************************
 *
 * XChain UTXO Tracker - Bulk Sync Loader
 *
 * Streams the per-prefix fixed-record files produced by derive-keys.js
 * into a levelup-backed DB (rocksdb or leveldown) via db.batch() writes.
 *
 * Each .dat file is a flat concatenation of (key || value) records of a
 * fixed size; we chunk them into batches of `batchSize` records and issue
 * one put-batch per chunk.
 *
 * LAST_* markers are written as string-encoded entries to match
 * LevelUpDb's schema: key = 'LAST_BLOCK_HEIGHT'/'LAST_BLOCK_HASH' (string),
 * value = hex-string / hash-string. These keys are NOT in any .dat file —
 * they are read from L.json.
 *
 ********************************************************************/

const fs   = require('fs')
const path = require('path')

const { LAYOUT }       = require('./derive-keys.js')
const { RecordReader } = require('./streaming-join.js')

// File name → prefix letter. Load order doesn't affect correctness for
// levelup (keys end up sorted internally). We go alphabetical which is
// also ascending prefix-byte order.
const PREFIX_FILES = ['B', 'H', 'I', 'J', 'N', 'O', 'S', 'T', 'Z']

function noop() {}

function openDb(dbPath, backend) {
    const levelup = require('levelup')
    let backendCtor
    if (backend === 'leveldown') {
        backendCtor = require('leveldown')
    } else if (backend === 'rocksdb') {
        backendCtor = require('rocksdb')
    } else {
        throw new Error(`loader: unknown backend '${backend}' (expected leveldown or rocksdb)`)
    }
    // Match LevelUpDb.js: no explicit encoding opts. Pass Buffer keys/values
    // verbatim via db.batch().
    return levelup(backendCtor(dbPath, {
        maxBackgroundCompactions: 1,
        maxBackgroundFlushes: 1,
    }))
}

async function loadPrefixFile(db, filePath, keySize, recordSize, batchSize) {
    const reader = new RecordReader(filePath, 0, recordSize)
    let total = 0
    let ops   = []

    try {
        while (true) {
            const rec = reader.next()
            if (!rec) break
            // Buffer.from copies — views are invalidated on next read.
            const key   = Buffer.from(rec.subarray(0, keySize))
            const value = Buffer.from(rec.subarray(keySize, recordSize))
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
 * @param {string}  opts.dbPath       DB directory path
 * @param {string}  opts.backend      'rocksdb' | 'leveldown'
 * @param {number}  opts.batchSize    records per batch (default 10000)
 * @param {Function} opts.onProgress  ({phase, ...})
 */
async function loadKeys(opts) {
    const { keysDir, dbPath, backend } = opts
    const batchSize  = opts.batchSize  || 10000
    const onProgress = opts.onProgress || noop

    if (!keysDir || !dbPath || !backend) {
        throw new Error('loadKeys: keysDir, dbPath, backend are required')
    }

    const db = openDb(dbPath, backend)
    await db.open()

    const stats = {}
    const startedAt = Date.now()

    try {
        for (const pfx of PREFIX_FILES) {
            const { keySize, recordSize } = LAYOUT[pfx]
            const filePath = path.join(keysDir, pfx + '.dat')
            if (!fs.existsSync(filePath)) {
                onProgress({ phase: 'skip', prefix: pfx, reason: 'file missing' })
                stats[pfx] = 0
                continue
            }
            const t0 = Date.now()
            const count = await loadPrefixFile(db, filePath, keySize, recordSize, batchSize)
            stats[pfx] = count
            onProgress({
                phase: 'prefix-done', prefix: pfx,
                count, elapsed_ms: Date.now() - t0,
            })
        }

        // L markers — string keys, string values (match LevelUpDb schema).
        const lPath = path.join(keysDir, 'L.json')
        if (!fs.existsSync(lPath)) throw new Error(`loadKeys: missing L.json at ${lPath}`)
        const L = JSON.parse(fs.readFileSync(lPath, 'utf8'))
        if (!('LAST_BLOCK_HEIGHT' in L) || !('LAST_BLOCK_HASH' in L)) {
            throw new Error('loadKeys: L.json missing LAST_BLOCK_HEIGHT / LAST_BLOCK_HASH')
        }
        await db.batch([
            { type: 'put', key: 'LAST_BLOCK_HEIGHT', value: L.LAST_BLOCK_HEIGHT },
            { type: 'put', key: 'LAST_BLOCK_HASH',   value: L.LAST_BLOCK_HASH   },
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
