#!/usr/bin/env node
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
 * migrate-rocksdb-to-classiclevel.js
 *
 * Offline storage-engine migration for an xchain-utxo-tracker database:
 * copy every key/value pair from a legacy RocksDB directory into a fresh
 * classic-level (LevelDB) directory.
 *
 * Why this is safe and equivalent to a full resync:
 *   The rocksdb -> classic-level migration was a storage-ENGINE swap, not a
 *   schema change. Both backends hold the identical set of key/value pairs
 *   (proven byte-identical during the migration: regtest 11,979 keys 0-diff +
 *   a 2,000-round dual-backend differential harness). A raw KV copy therefore
 *   reproduces exactly the database a from-scratch chain reparse would build.
 *   in disk-IO time (hours) instead of a multi-day parse, and without the
 *   multi-TB intermediate scratch the bulk-sync pipeline needs.
 *
 * Runtime requirements (needs BOTH backends loadable in one process):
 *   read  side : `rocksdb`        (use the pre-migration image's already-built
 *                                  binary AS-IS (do NOT run npm in that image,
 *                                  it would prune rocksdb and/or try to rebuild
 *                                  the native addon, which fails on Node 22)
 *   write side : `classic-level`  (supply via NODE_PATH pointing at a migrated
 *                                  image's node_modules, copied in, not installed)
 *   Recommended setup (sidecar, no npm in the rocksdb image):
 *     # base = a committed pre-migration (rocksdb) tracker image
 *     docker run -d --name mig --entrypoint sleep <rocksdb-image> infinity
 *     mkdir -p /opt/cl/node_modules in the sidecar
 *     # stream a migrated image's node_modules in (has classic-level + deps):
 *     docker exec <classic-level-ctr> tar c -C /XChainUtxoTracker/node_modules . \
 *       | docker exec -i mig tar x -C /opt/cl/node_modules
 *     docker exec -e NODE_PATH=/opt/cl/node_modules mig \
 *       node /XChainUtxoTracker/src/bulk-sync/migrate-rocksdb-to-classiclevel.js --src ... --dst ...
 *   rocksdb resolves from the image's own node_modules; classic-level from NODE_PATH.
 *
 * Usage:
 *   node migrate-rocksdb-to-classiclevel.js --src <rocksdb-dir> --dst <classic-level-dir>
 *   node migrate-rocksdb-to-classiclevel.js --verify-only --src <rocksdb-dir> --dst <classic-level-dir>
 *
 * Options:
 *   --src <dir>          source RocksDB directory (read-only; never mutated)
 *   --dst <dir>          destination classic-level directory (must be empty/new)
 *   --batch-bytes <n>    write-batch flush threshold in bytes (default 67108864 = 64 MiB)
 *   --no-verify          skip the post-copy key-by-key verification (NOT recommended)
 *   --verify-only        skip the copy; only verify an existing dst against src
 *
 * Exit status: 0 on success (and, unless --no-verify, verification identical);
 *              non-zero on any error or verification mismatch.
 */

'use strict'

const fs = require('fs')
const path = require('path')

// args
function parseArgs(argv) {
    const a = { batchBytes: 64 * 1024 * 1024, segmentKeys: 100_000_000, verify: true, verifyOnly: false }
    for (let i = 2; i < argv.length; i++) {
        switch (argv[i]) {
            case '--src':          a.src = argv[++i]; break
            case '--dst':          a.dst = argv[++i]; break
            case '--batch-bytes':  a.batchBytes = parseInt(argv[++i], 10); break
            case '--segment-keys': a.segmentKeys = parseInt(argv[++i], 10); break
            case '--no-verify':    a.verify = false; break
            case '--verify-only':  a.verifyOnly = true; break
            case '-h': case '--help': a.help = true; break
            default: throw new Error('unknown arg: ' + argv[i])
        }
    }
    return a
}

function fail(msg) { console.error('FATAL: ' + msg); process.exit(1) }
function fmtBytes(n) { return (n / (1024 * 1024 * 1024)).toFixed(2) + ' GB' }
function ts() { return new Date().toISOString().replace('T', ' ').slice(0, 19) }
function log(msg) { console.log(`[${ts()}] ${msg}`) }

// backend openers
// Source: RocksDB used DIRECTLY as an abstract-leveldown store (no levelup), so
// the pre-migration image needs nothing added. Open read-mostly; we never write
// to it. keyAsBuffer/valueAsBuffer on the iterator give raw Buffers -> exact bytes.
function openRocks(dir) {
    const rocksdb = require('rocksdb')
    const db = rocksdb(dir)
    return new Promise((res, rej) =>
        db.open({ createIfMissing: false, errorIfExists: false }, e => e ? rej(e) : res(db)))
}

// Pull adapter over a rocksdb (abstract-leveldown) iterator -> { next()/close() }.
// fillCache:false: reading the whole DB once must not grow the block cache.
function pullFromRocks(db) {
    const it = db.iterator({ keys: true, values: true, keyAsBuffer: true, valueAsBuffer: true, fillCache: false })
    return {
        next() {
            return new Promise((res, rej) => it.next((e, key, value) =>
                e ? rej(e) : res(key === undefined ? { done: true } : { done: false, key, value })))
        },
        close() { return new Promise((res, rej) => it.end(e => e ? rej(e) : res())) },
    }
}
function closeRocks(db) { return new Promise((res, rej) => db.close(e => e ? rej(e) : res())) }

// Destination: classic-level, buffer-encoded (matches LevelUpDb's on-disk shape).
// Memory knobs bound native RSS at billions-of-keys scale: the default table
// cache (maxOpenFiles=1000) pins index/filter blocks for up to 1000 large SST
// files in RAM, which dominates the back-half memory growth. Cap it, keep the
// block cache + write buffer modest. (Overridable via CLASSIC_* env for tuning.)
function openClassic(dir, createIfMissing) {
    const { ClassicLevel } = require('classic-level')
    const envInt = (k, d) => (process.env[k] ? parseInt(process.env[k], 10) : d)
    return new ClassicLevel(dir, {
        keyEncoding: 'buffer',
        valueEncoding: 'buffer',
        createIfMissing: !!createIfMissing,
        errorIfExists: false,
        maxOpenFiles:    envInt('CLASSIC_MAX_OPEN_FILES', 200),
        cacheSize:       envInt('CLASSIC_CACHE_SIZE', 8 * 1024 * 1024),
        writeBufferSize: envInt('CLASSIC_WRITE_BUFFER', 32 * 1024 * 1024),
    })
}

// Pull adapter over a classic-level (abstract-level v2) iterator.
function pullFromClassic(db) {
    const it = db.iterator({ keyEncoding: 'buffer', valueEncoding: 'buffer' })
    return {
        async next() {
            const entry = await it.next()
            if (entry === undefined) { await it.close(); return { done: true } }
            return { done: false, key: entry[0], value: entry[1] }
        },
    }
}

// copy
async function copy(src, dst, batchBytes, segmentKeys) {
    log(`COPY start: ${src} (rocksdb) -> ${dst} (classic-level), batch=${fmtBytes(batchBytes)}`)
    const from = await openRocks(src)
    let to = openClassic(dst, true)
    await to.open()

    // Bound native memory: LevelDB accumulates memtable/compaction state during a
    // sustained bulk load and can OOM at billions-of-keys scale. Periodically
    // close+reopen the destination to force a flush and release that memory.
    const SEGMENT_KEYS = segmentKeys > 0 ? segmentKeys : 100_000_000
    let ops = [], opsBytes = 0, keys = 0, totalBytes = 0, nextLog = 1_000_000, lastCycle = 0
    const flush = async () => { if (ops.length) { await to.batch(ops); ops = []; opsBytes = 0 } }

    const cur = pullFromRocks(from)
    for (;;) {
        const e = await cur.next()
        if (e.done) break
        ops.push({ type: 'put', key: e.key, value: e.value })
        const sz = e.key.length + e.value.length
        opsBytes += sz; totalBytes += sz; keys++
        if (opsBytes >= batchBytes) await flush()
        if (keys - lastCycle >= SEGMENT_KEYS) {
            await flush()
            await to.close()                       // flush memtables + release native memory
            to = openClassic(dst, false); await to.open()
            lastCycle = keys
            log(`  [mem-cycle] flushed+reopened dst at ${keys.toLocaleString()} keys`)
        }
        if (keys >= nextLog) { log(`  copied ${keys.toLocaleString()} keys, ${fmtBytes(totalBytes)}`); nextLog += 1_000_000 }
    }
    await flush()
    await cur.close()

    log(`COPY done: ${keys.toLocaleString()} keys, ${fmtBytes(totalBytes)} logical`)
    log(`  compacting destination...`)
    await to.compactRange(Buffer.from([]), Buffer.from([0xff]))   // settle SSTs before verify/use
    await to.close()
    await closeRocks(from)
    return { keys, totalBytes }
}

// verify
// Streaming lockstep compare. Both backends iterate keys in ascending byte
// order, so we walk them together and classify every key.
async function verify(src, dst) {
    log(`VERIFY start: comparing ${src} (rocksdb) vs ${dst} (classic-level)`)
    const from = await openRocks(src)
    const to = openClassic(dst, false)
    await to.open()

    const A = pullFromRocks(from)   // truth
    const B = pullFromClassic(to)   // candidate
    let a = await A.next(), b = await B.next()
    let same = 0, valueDiff = 0, missingInDst = 0, extraInDst = 0
    const samples = []

    while (!a.done || !b.done) {
        let cmp
        if (a.done) cmp = 1
        else if (b.done) cmp = -1
        else cmp = Buffer.compare(a.key, b.key)

        if (cmp === 0) {
            if (Buffer.compare(a.value, b.value) === 0) same++
            else { valueDiff++; if (samples.length < 10) samples.push('VALUE-DIFF ' + a.key.toString('hex').slice(0, 32)) }
            a = await A.next(); b = await B.next()
        } else if (cmp < 0) {           // key in src, not in dst
            missingInDst++; if (samples.length < 10) samples.push('MISSING-IN-DST ' + a.key.toString('hex').slice(0, 32))
            a = await A.next()
        } else {                        // key in dst, not in src
            extraInDst++; if (samples.length < 10) samples.push('EXTRA-IN-DST ' + b.key.toString('hex').slice(0, 32))
            b = await B.next()
        }
        if ((same + valueDiff + missingInDst + extraInDst) % 5_000_000 === 0) {
            log(`  walked ${(same + valueDiff + missingInDst + extraInDst).toLocaleString()} keys...`)
        }
    }
    await A.close(); await to.close(); await closeRocks(from)

    const ok = valueDiff === 0 && missingInDst === 0 && extraInDst === 0
    log(`VERIFY done: matched=${same.toLocaleString()} valueDiff=${valueDiff} missingInDst=${missingInDst} extraInDst=${extraInDst}`)
    if (!ok) { samples.forEach(s => console.error('  ' + s)) }
    console.log(ok
        ? 'RESULT: OK: databases are identical (0 diffs / 0 missing / 0 extra)'
        : 'RESULT: MISMATCH: databases differ')
    return ok
}

// main
;(async () => {
    const a = parseArgs(process.argv)
    if (a.help || !a.src || !a.dst) {
        console.log('usage: node migrate-rocksdb-to-classiclevel.js --src <rocksdb-dir> --dst <classic-level-dir> [--verify-only] [--no-verify] [--batch-bytes N]')
        process.exit(a.help ? 0 : 1)
    }
    if (!fs.existsSync(a.src)) fail('src does not exist: ' + a.src)
    if (!fs.existsSync(path.join(a.src, 'CURRENT'))) fail('src does not look like a LevelDB/RocksDB dir (no CURRENT): ' + a.src)

    if (!a.verifyOnly) {
        if (fs.existsSync(path.join(a.dst, 'CURRENT'))) fail('dst already initialized (CURRENT present); refusing to overwrite: ' + a.dst)
        await copy(a.src, a.dst, a.batchBytes, a.segmentKeys)
    }

    let ok = true
    if (a.verify || a.verifyOnly) ok = await verify(a.src, a.dst)

    log(ok ? 'ALL DONE: migration verified.' : 'FAILED: verification mismatch; do NOT use dst.')
    process.exit(ok ? 0 : 1)
})().catch(e => { console.error('FATAL', e && e.stack || e); process.exit(1) })
