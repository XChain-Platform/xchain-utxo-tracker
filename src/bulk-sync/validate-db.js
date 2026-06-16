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
 *
 * XChain UTXO Tracker - Bulk Sync DB Validator
 *
 * Compares two LevelUpDb (classic-level / LevelDB) directories key-by-key via
 * a streaming merge-walk. Reports total keys, matches, value diffs, keys
 * only in truth, keys only in candidate — broken down by prefix byte.
 * Prints the first N diffs verbatim for inspection.
 *
 * Both DBs must be closed (not in use by another process).
 *
 ********************************************************************/

const { ClassicLevel } = require('classic-level')

const DEFAULT_LIMIT   = 20

function parseArgs(argv) {
    const args = {
        limit: DEFAULT_LIMIT
    }
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i]
        switch (arg) {
            case '--truth':             args.truth = argv[++i]; break
            case '--candidate':         args.candidate = argv[++i]; break
            // Legacy backend flags — the only backend now is classic-level.
            // Accepted (and ignored) so older invocations don't error out.
            case '--truth-backend':
            case '--candidate-backend':
            case '--backend':           i++; break
            case '--limit':             args.limit = parseInt(argv[++i], 10); break
            case '--prefix':            args.prefix = argv[++i]; break
            case '--help':
            case '-h':
                printHelp()
                process.exit(0)
            default:
                throw new Error('Unknown argument: ' + arg)
        }
    }
    return args
}

function printHelp() {
    console.log(`Usage: node src/bulk-sync/validate-db.js [options]

Options:
  --truth <path>              Ground-truth DB directory (required)
  --candidate <path>          Candidate DB directory (required)
  --limit <n>                 Max diffs to print verbatim (default ${DEFAULT_LIMIT})
  --prefix <hex>              Filter to keys starting with this hex byte (e.g. 42 for 'B')

Both DBs are classic-level (LevelDB) directories and must be closed.

Examples:
  node src/bulk-sync/validate-db.js --truth /data/a --candidate /data/b
  node src/bulk-sync/validate-db.js --truth /data/truth --candidate /data/cand --prefix 4F
`)
}

function validateArgs(args) {
    if (!args.truth)     throw new Error('--truth is required')
    if (!args.candidate) throw new Error('--candidate is required')
    if (!Number.isFinite(args.limit) || args.limit < 0) {
        throw new Error('--limit must be a non-negative integer')
    }
    if (args.prefix != null) {
        if (!/^[0-9a-fA-F]{2}$/.test(args.prefix)) {
            throw new Error('--prefix must be a 2-char hex byte (e.g. 42)')
        }
        args.prefixByte = parseInt(args.prefix, 16)
    }
}

async function openDb(path) {
    const db = new ClassicLevel(path, { keyEncoding: 'buffer', valueEncoding: 'buffer' })
    await db.open()
    return db
}

// Pull-based adapter over an abstract-level iterator so the two-way merge-walk
// below can advance each side independently. abstract-level's `it.next()`
// resolves to a [key, value] tuple or undefined at end-of-stream.
function makeIterator(db, options) {
    const it = db.iterator(options)
    return {
        next: async () => {
            const entry = await it.next()
            if (entry === undefined) return null
            const [key, value] = entry
            return { key, value }
        },
        end: () => it.close()
    }
}

function prefixLabel(buf) {
    if (!buf || buf.length === 0) return '<empty>'
    const b = buf[0]
    if (b >= 0x20 && b <= 0x7e) return String.fromCharCode(b) + ` (0x${b.toString(16).padStart(2, '0')})`
    return `0x${b.toString(16).padStart(2, '0')}`
}

function prefixKey(buf) {
    if (!buf || buf.length === 0) return '<empty>'
    return buf[0].toString(16).padStart(2, '0')
}

function bump(obj, key, field) {
    if (!obj[key]) obj[key] = { matches: 0, diffs: 0, missing: 0, extra: 0 }
    obj[key][field]++
}

function fmtKey(buf) {
    if (buf.length <= 48) return buf.toString('hex')
    return buf.slice(0, 48).toString('hex') + `…(+${buf.length - 48}B)`
}

function fmtVal(buf) {
    if (!buf) return '<null>'
    if (buf.length <= 48) return buf.toString('hex')
    return buf.slice(0, 48).toString('hex') + `…(+${buf.length - 48}B)`
}

async function main() {
    const args = parseArgs(process.argv)
    validateArgs(args)

    console.log(`[validate-db] truth     = ${args.truth}`)
    console.log(`[validate-db] candidate = ${args.candidate}`)
    if (args.prefix != null) console.log(`[validate-db] prefix filter = 0x${args.prefix}`)

    const truthDb = await openDb(args.truth)
    const candDb  = await openDb(args.candidate)

    let itOpts = { keyEncoding: 'buffer', valueEncoding: 'buffer' }
    if (args.prefixByte != null) {
        itOpts.gte = Buffer.from([args.prefixByte])
        itOpts.lt  = Buffer.from([args.prefixByte + 1])
    }

    const itA = makeIterator(truthDb, itOpts)
    const itB = makeIterator(candDb,  itOpts)

    const startedAt = Date.now()
    const stats = {}
    const diffs = []
    let a = await itA.next()
    let b = await itB.next()

    while (a !== null || b !== null) {
        if (a === null) {
            bump(stats, prefixKey(b.key), 'extra')
            if (diffs.length < args.limit) {
                diffs.push({ type: 'extra', key: Buffer.from(b.key), value: Buffer.from(b.value) })
            }
            b = await itB.next()
            continue
        }
        if (b === null) {
            bump(stats, prefixKey(a.key), 'missing')
            if (diffs.length < args.limit) {
                diffs.push({ type: 'missing', key: Buffer.from(a.key), value: Buffer.from(a.value) })
            }
            a = await itA.next()
            continue
        }

        const cmp = Buffer.compare(a.key, b.key)
        if (cmp === 0) {
            const p = prefixKey(a.key)
            if (Buffer.compare(a.value, b.value) === 0) {
                bump(stats, p, 'matches')
            } else {
                bump(stats, p, 'diffs')
                if (diffs.length < args.limit) {
                    diffs.push({
                        type: 'diff',
                        key: Buffer.from(a.key),
                        truthValue: Buffer.from(a.value),
                        candValue:  Buffer.from(b.value)
                    })
                }
            }
            a = await itA.next()
            b = await itB.next()
        } else if (cmp < 0) {
            bump(stats, prefixKey(a.key), 'missing')
            if (diffs.length < args.limit) {
                diffs.push({ type: 'missing', key: Buffer.from(a.key), value: Buffer.from(a.value) })
            }
            a = await itA.next()
        } else {
            bump(stats, prefixKey(b.key), 'extra')
            if (diffs.length < args.limit) {
                diffs.push({ type: 'extra', key: Buffer.from(b.key), value: Buffer.from(b.value) })
            }
            b = await itB.next()
        }
    }

    await itA.end()
    await itB.end()
    await truthDb.close()
    await candDb.close()

    // ── Report ────────────────────────────────────────────────────────────
    const elapsed = Date.now() - startedAt
    const prefixes = Object.keys(stats).sort()

    let tMatches = 0, tDiffs = 0, tMissing = 0, tExtra = 0
    console.log('')
    console.log('Per-prefix breakdown:')
    console.log('  prefix       matches      diffs    missing      extra')
    for (const p of prefixes) {
        const s = stats[p]
        tMatches += s.matches
        tDiffs   += s.diffs
        tMissing += s.missing
        tExtra   += s.extra
        const label = prefixLabel(Buffer.from([parseInt(p, 16)])).padEnd(10)
        console.log(`  ${label} ${String(s.matches).padStart(10)} ${String(s.diffs).padStart(10)} ${String(s.missing).padStart(10)} ${String(s.extra).padStart(10)}`)
    }
    console.log('  ' + '-'.repeat(55))
    console.log(`  ${'TOTAL'.padEnd(10)} ${String(tMatches).padStart(10)} ${String(tDiffs).padStart(10)} ${String(tMissing).padStart(10)} ${String(tExtra).padStart(10)}`)

    if (diffs.length > 0) {
        console.log('')
        console.log(`First ${diffs.length} differences:`)
        for (const d of diffs) {
            if (d.type === 'diff') {
                console.log(`  [diff]    key=${fmtKey(d.key)}`)
                console.log(`            truth=${fmtVal(d.truthValue)}`)
                console.log(`            cand =${fmtVal(d.candValue)}`)
            } else if (d.type === 'missing') {
                console.log(`  [missing] key=${fmtKey(d.key)} value=${fmtVal(d.value)}`)
            } else if (d.type === 'extra') {
                console.log(`  [extra]   key=${fmtKey(d.key)} value=${fmtVal(d.value)}`)
            }
        }
    }

    console.log('')
    const totalKeys = tMatches + tDiffs + tMissing + tExtra
    console.log(`[validate-db] ${totalKeys} keys compared in ${(elapsed / 1000).toFixed(1)}s`)
    const ok = tDiffs === 0 && tMissing === 0 && tExtra === 0
    if (ok) {
        console.log('[validate-db] RESULT: OK — databases are identical')
        process.exit(0)
    } else {
        console.log(`[validate-db] RESULT: MISMATCH — ${tDiffs} diffs, ${tMissing} missing, ${tExtra} extra`)
        process.exit(2)
    }
}

main().catch(err => {
    console.error('[validate-db] FATAL:', err.message)
    if (err.stack) console.error(err.stack)
    process.exit(1)
})
