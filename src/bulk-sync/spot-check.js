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
 * XChain UTXO Tracker - Bulk Sync Spot-Check
 *
 * Random-sample byte-exact validation of a candidate DB vs a truth DB,
 * grouped by key-prefix byte. Unlike validate-db (full merge-walk), this
 * is appropriate when the two DBs cover different block ranges — it only
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
 *                  tip drift, etc. — script does not classify)
 *
 * Exit codes:
 *   0 = no byte-level mismatches on hits
 *   1 = ≥1 mismatch on a hit (this is always a bug)
 *   2 = usage error / fatal
 *
 ********************************************************************/

const levelup = require('levelup')

const DEFAULT_SAMPLES = 500
const DEFAULT_BACKEND = 'rocksdb'
const MISMATCHES_PER_PREFIX = 3

function parseArgs(argv) {
    const args = {
        samples:  DEFAULT_SAMPLES,
        backend:  DEFAULT_BACKEND,
        prefixes: null,   // null = auto-detect from candidate
        seed:     null,
    }
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i]
        switch (a) {
            case '--truth':     args.truth     = argv[++i]; break
            case '--candidate': args.candidate = argv[++i]; break
            case '--samples':   args.samples   = parseInt(argv[++i], 10); break
            case '--backend':   args.backend   = argv[++i]; break
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
    if (args.backend !== 'rocksdb' && args.backend !== 'leveldown') {
        throw new Error('--backend must be rocksdb or leveldown')
    }
    return args
}

function printHelp() {
    console.log(`Usage: node spot-check.js --truth <dir> --candidate <dir> [options]

Required:
  --truth <dir>       path to ground-truth DB (must be closed / not in use)
  --candidate <dir>   path to candidate DB    (must be closed / not in use)

Options:
  --samples <n>       random samples per prefix (default ${DEFAULT_SAMPLES})
  --backend <name>    rocksdb | leveldown (default ${DEFAULT_BACKEND})
  --prefixes <hex>    comma-separated hex bytes to sample (default: auto)
                      e.g. "42,54,53" for prefixes B, T, S
  --seed <n>          PRNG seed for reproducible sampling

Exit codes:
  0  no byte-level mismatches on hits
  1  ≥1 mismatch on a hit
  2  usage or runtime error
`)
}

function loadBackend(name) {
    try {
        return require(name)
    } catch (err) {
        throw new Error(`Failed to load backend "${name}": ${err.message}`)
    }
}

function openDb(path, backendName) {
    const backend = loadBackend(backendName)
    return new Promise((resolve, reject) => {
        const db = levelup(backend(path), err => err ? reject(err) : resolve(db))
    })
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
        while (true) {
            const entry = await new Promise((resolve, reject) => {
                it.next((err, key, value) => {
                    if (err) reject(err)
                    else if (key === undefined) resolve(null)
                    else resolve({
                        key:   Buffer.from(key),
                        value: value ? Buffer.from(value) : null,
                    })
                })
            })
            if (!entry) break
            yield entry
        }
    } finally {
        await new Promise((resolve, reject) => it.end(err => err ? reject(err) : resolve()))
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
    for await (const e of iterate(db, { keyAsBuffer: true, values: false })) {
        if (e.key.length > 0) seen.add(e.key[0])
    }
    return [...seen].sort((a, b) => a - b)
}

async function main() {
    const args = parseArgs(process.argv)
    const seed = args.seed != null ? args.seed : (Date.now() & 0xFFFFFFFF)

    console.log(`[spot-check] truth     = ${args.truth}`)
    console.log(`[spot-check] candidate = ${args.candidate}`)
    console.log(`[spot-check] backend   = ${args.backend}`)
    console.log(`[spot-check] samples   = ${args.samples} per prefix`)
    console.log(`[spot-check] seed      = ${seed}`)

    const truthDb = await openDb(args.truth,     args.backend)
    const candDb  = await openDb(args.candidate, args.backend)

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
            keyAsBuffer:   true,
            valueAsBuffer: true,
            gte:           Buffer.from([p]),
            lt:            Buffer.from([p + 1]),
        }
        const rng = makeRng(seed ^ (p << 24))
        const { reservoir, total } = await reservoirSample(candDb, itOpts, args.samples, rng)

        let hits = 0, exact = 0, mismatch = 0, miss = 0
        const mismatches = []
        for (const { key, value } of reservoir) {
            let truthValue = null
            try {
                truthValue = await truthDb.get(key)
            } catch (err) {
                if (err.notFound) { miss++; continue }
                throw err
            }
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
        console.log('[spot-check] RESULT: OK — no byte-level mismatches on any hit')
        process.exit(0)
    } else {
        console.log(`[spot-check] RESULT: MISMATCH — ${totalMismatch} byte-level diffs on hits`)
        process.exit(1)
    }
}

main().catch(err => {
    console.error('[spot-check] FATAL:', err.message)
    if (err.stack) console.error(err.stack)
    process.exit(2)
})
