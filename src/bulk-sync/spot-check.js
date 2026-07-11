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
 * XChain UTXO Tracker - Bulk Sync Spot-Check
 *
 * Random-sample byte-exact validation of a candidate DB vs a truth DB,
 * grouped by key-prefix byte. Unlike validate-db (full merge-walk), this
 * is appropriate when the two DBs cover different block ranges. It only
 * checks whether candidate keys, when they exist in truth, hold the same
 * bytes.
 *
 * Statistical basis: 500 samples per prefix gives ≥99% probability of
 * detecting ≥1% defect rate on that prefix (n = log(0.01)/log(0.99) ≈ 458).
 *
 * For each sampled candidate record (key, cand_value):
 *   - GET key from truth
 *   - If found  → compare byte-exact (count exact vs mismatch)
 *   - If absent → count as miss (can be legitimate: option-a divergence,
 *                  tip drift, etc.; script does not classify)
 *
 * Exit codes:
 *   0 = no byte-level mismatches on hits
 *   1 = ≥1 mismatch on a hit (this is always a bug)
 *   2 = usage error / fatal
 *
 ********************************************************************/

const { ClassicLevel } = require('classic-level')

const DEFAULT_SAMPLES = 500
const MISMATCHES_PER_PREFIX = 3

function parseArgs(argv) {
    const args = {
        samples:  DEFAULT_SAMPLES,
        prefixes: null,   // null = auto-detect from candidate
        seed:     null,
    }
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i]
        switch (a) {
            case '--truth':     args.truth     = argv[++i]; break
            case '--candidate': args.candidate = argv[++i]; break
            case '--samples':   args.samples   = parseInt(argv[++i], 10); break
            // Legacy backend flag (the only backend now is classic-level).
            // Accepted (and ignored) so older invocations don't error out.
            case '--backend':   i++; break
            case '--prefixes':  args.prefixes  = argv[++i]; break
            case '--seed':      args.seed      = parseInt(argv[++i], 10); break
            case '-h':
            case '--help':      printHelp(); process.exit(0)
            default:            throw new Error('unknown arg: ' + a)
        }
    }
    if (!args.truth)                 throw new Error('--truth is required')
    if (!args.candidate)             throw new Error('--candidate is required')
    if (!(args.samples > 0))         throw new Error('--samples must be > 0')
    return args
}

function printHelp() {
    console.log(`Usage: node spot-check.js --truth <dir> --candidate <dir> [options]

Required:
  --truth <dir>       path to ground-truth DB (must be closed / not in use)
  --candidate <dir>   path to candidate DB    (must be closed / not in use)

Both DBs are classic-level (LevelDB) directories and must be closed.

Options:
  --samples <n>       random samples per prefix (default ${DEFAULT_SAMPLES})
  --prefixes <hex>    comma-separated hex bytes to sample (default: auto)
                      e.g. "42,54,53" for prefixes B, T, S
  --seed <n>          PRNG seed for reproducible sampling

Exit codes:
  0  no byte-level mismatches on hits
  1  ≥1 mismatch on a hit
  2  usage or runtime error
`)
}

async function openDb(path) {
    const db = new ClassicLevel(path, { keyEncoding: 'buffer', valueEncoding: 'buffer' })
    await db.open()
    return db
}

function makeRng(seed) {
    let s = seed >>> 0
    return () => {
        s = (s + 0x6D2B79F5) >>> 0
        let t = s
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

async function* iterate(db, itOpts) {
    const it = db.iterator(itOpts)
    try {
        for await (const [key, value] of it) {
            yield {
                key:   Buffer.from(key),
                value: value != null ? Buffer.from(value) : null,
            }
        }
    } finally {
        await it.close()
    }
}

async function reservoirSample(db, itOpts, n, rng) {
    const reservoir = []
    let seen = 0
    for await (const e of iterate(db, itOpts)) {
        seen++
        if (reservoir.length < n) {
            reservoir.push(e)
        } else {
            const j = Math.floor(rng() * seen)
            if (j < n) reservoir[j] = e
        }
    }
    return { reservoir, total: seen }
}

function prefixLabel(b) {
    const hex = '0x' + b.toString(16).padStart(2, '0')
    if (b >= 0x20 && b <= 0x7e) return `'${String.fromCharCode(b)}' ${hex}`
    return hex
}

function fmtHex(buf, max = 48) {
    if (!buf) return '<null>'
    if (buf.length <= max) return buf.toString('hex')
    return buf.slice(0, max).toString('hex') + `…(+${buf.length - max}B)`
}

async function detectPrefixes(db) {
    const seen = new Set()
    for await (const e of iterate(db, { keyEncoding: 'buffer', values: false })) {
        if (e.key.length > 0) seen.add(e.key[0])
    }
    return [...seen].sort((a, b) => a - b)
}

async function main() {
    const args = parseArgs(process.argv)
    const seed = args.seed != null ? args.seed : (Date.now() & 0xFFFFFFFF)

    console.log(`[spot-check] truth     = ${args.truth}`)
    console.log(`[spot-check] candidate = ${args.candidate}`)
    console.log(`[spot-check] samples   = ${args.samples} per prefix`)
    console.log(`[spot-check] seed      = ${seed}`)

    const truthDb = await openDb(args.truth)
    const candDb  = await openDb(args.candidate)

    let prefixBytes
    if (args.prefixes) {
        prefixBytes = args.prefixes.split(',').map(h => {
            const n = parseInt(h.trim(), 16)
            if (!Number.isFinite(n) || n < 0 || n > 255) {
                throw new Error(`bad prefix: "${h}"`)
            }
            return n
        })
    } else {
        console.log('[spot-check] detecting prefixes in candidate...')
        prefixBytes = await detectPrefixes(candDb)
    }
    console.log(`[spot-check] prefixes  = ${prefixBytes.map(prefixLabel).join(', ')}`)
    console.log('')

    const startedAt = Date.now()
    const rows = []

    for (const p of prefixBytes) {
        const itOpts = {
            keyEncoding:   'buffer',
            valueEncoding: 'buffer',
            gte:           Buffer.from([p]),
        }
        // 0xFF+1 truncates to 0x00 and empties the range (vacuous pass).
        if (p !== 0xFF) itOpts.lt = Buffer.from([p + 1])
        const rng = makeRng(seed ^ (p << 24))
        const { reservoir, total } = await reservoirSample(candDb, itOpts, args.samples, rng)

        let hits = 0, exact = 0, mismatch = 0, miss = 0
        const mismatches = []
        for (const { key, value } of reservoir) {
            // abstract-level .get returns undefined on a miss (no throw).
            const truthValue = await truthDb.get(key)
            if (truthValue === undefined) { miss++; continue }
            hits++
            const tBuf = Buffer.isBuffer(truthValue) ? truthValue : Buffer.from(truthValue)
            if (Buffer.compare(value, tBuf) === 0) {
                exact++
            } else {
                mismatch++
                if (mismatches.length < MISMATCHES_PER_PREFIX) {
                    mismatches.push({ key, cand: value, truth: tBuf })
                }
            }
        }
        rows.push({
            prefix:     p,
            total,
            sampled:    reservoir.length,
            hits, exact, mismatch, miss,
            mismatches,
        })
    }

    await truthDb.close()
    await candDb.close()

    // ── Report ────────────────────────────────────────────────────────────
    console.log('Per-prefix spot-check:')
    console.log('  prefix         total   sampled     hits    exact     diff     miss')
    let totalMismatch = 0
    for (const r of rows) {
        totalMismatch += r.mismatch
        const label = prefixLabel(r.prefix).padEnd(12)
        console.log(`  ${label} ${String(r.total).padStart(9)} ${String(r.sampled).padStart(9)}`
            + ` ${String(r.hits).padStart(8)} ${String(r.exact).padStart(8)}`
            + ` ${String(r.mismatch).padStart(8)} ${String(r.miss).padStart(8)}`)
    }

    if (totalMismatch > 0) {
        console.log('')
        console.log('Byte-level mismatches (sampled):')
        for (const r of rows) {
            for (const m of r.mismatches) {
                console.log(`  [${prefixLabel(r.prefix)}] key=${fmtHex(m.key)}`)
                console.log(`    truth = ${fmtHex(m.truth)}`)
                console.log(`    cand  = ${fmtHex(m.cand)}`)
            }
        }
    }

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
    console.log('')
    console.log(`[spot-check] done in ${elapsed}s`)
    if (totalMismatch === 0) {
        console.log('[spot-check] RESULT: OK - no byte-level mismatches on any hit')
        process.exit(0)
    } else {
        console.log(`[spot-check] RESULT: MISMATCH - ${totalMismatch} byte-level diffs on hits`)
        process.exit(1)
    }
}

main().catch(err => {
    console.error('[spot-check] FATAL:', err.message)
    if (err.stack) console.error(err.stack)
    process.exit(2)
})
