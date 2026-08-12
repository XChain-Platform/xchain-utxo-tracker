'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Ad-hoc smoke test for external-sort.js. Covers:
//   - Single-run (everything fits in RAM): deterministic random records → verify sorted order byte-per-byte
//   - Multi-run (forced by tiny ramBudget): same correctness
//   - Header preservation
//   - Empty input
//   - Record count mismatch with recordSize → must throw

const fs     = require('fs')
const os     = require('os')
const path   = require('path')
const crypto = require('crypto')
const assert = require('assert')

const { externalSort, MinHeap } = require('./external-sort.js')

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-ext-sort-'))
console.log('[smoke/external-sort] tmp dir:', TMP_DIR)

// Seeded PRNG for reproducibility (linear congruential).
function rng(seed) {
    let x = seed >>> 0
    return () => {
        x = (Math.imul(x, 1664525) + 1013904223) >>> 0
        return x
    }
}

function buildRandomRecords(count, recordSize, seed) {
    const buf = Buffer.alloc(count * recordSize)
    const r = rng(seed)
    for (let i = 0; i < count * recordSize; i += 4) {
        buf.writeUInt32LE(r() >>> 0, i)
    }
    return buf
}

function isSorted(filePath, headerSize, recordSize, keySize, expectedCount) {
    const fd   = fs.openSync(filePath, 'r')
    const stat = fs.fstatSync(fd)
    const dataBytes = stat.size - headerSize
    assert.strictEqual(dataBytes % recordSize, 0, 'data size not multiple of recordSize')
    const n = dataBytes / recordSize
    assert.strictEqual(n, expectedCount, `expected ${expectedCount} records, got ${n}`)

    const bufA = Buffer.alloc(recordSize)
    const bufB = Buffer.alloc(recordSize)
    fs.readSync(fd, bufA, 0, recordSize, headerSize)
    for (let i = 1; i < n; i++) {
        fs.readSync(fd, bufB, 0, recordSize, headerSize + i * recordSize)
        const cmp = Buffer.compare(bufA.subarray(0, keySize), bufB.subarray(0, keySize))
        assert.ok(cmp <= 0, `records ${i-1} and ${i} out of order`)
        bufA.set(bufB)
    }
    fs.closeSync(fd)
}

// MinHeap basic sanity
{
    const h = new MinHeap()
    const vals = [5, 1, 9, 3, 7, 2, 8, 4, 6, 0]
    for (const v of vals) h.push(Buffer.from([v]), v)
    const out = []
    while (h.size > 0) out.push(h.pop().payload)
    assert.deepStrictEqual(out, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    console.log('[smoke/external-sort] MinHeap OK')
}

async function main() {
    // Reset tmp dir for clean async run.
    fs.rmSync(TMP_DIR, { recursive: true, force: true })
    fs.mkdirSync(TMP_DIR)

    // Case A: single-run, no header
    {
        const RS = 20, KS = 12, N = 5000
        const records = buildRandomRecords(N, RS, 42)
        const inPath  = path.join(TMP_DIR, 'a.in')
        const outPath = path.join(TMP_DIR, 'a.out')
        fs.writeFileSync(inPath, records)
        const res = await externalSort({
            inputPath: inPath, outputPath: outPath,
            recordSize: RS, keySize: KS,
            ramBudgetBytes: 1024 * 1024,
            tmpDir: path.join(TMP_DIR, 'a-tmp'),
        })
        assert.strictEqual(res.recordsSorted, N)
        assert.strictEqual(res.runsCreated, 1, 'should fit in one run')
        isSorted(outPath, 0, RS, KS, N)
        console.log('[smoke/external-sort] case A single-run OK')
    }

    // Case B: multi-run (force 10 runs)
    {
        const RS = 20, KS = 12, N = 10000
        const records = buildRandomRecords(N, RS, 123)
        const inPath  = path.join(TMP_DIR, 'b.in')
        const outPath = path.join(TMP_DIR, 'b.out')
        fs.writeFileSync(inPath, records)
        // 1000 records per run → 10 runs.
        const res = await externalSort({
            inputPath: inPath, outputPath: outPath,
            recordSize: RS, keySize: KS,
            ramBudgetBytes: 1000 * RS,
            tmpDir: path.join(TMP_DIR, 'b-tmp'),
        })
        assert.strictEqual(res.recordsSorted, N)
        assert.strictEqual(res.runsCreated, 10, `expected 10 runs, got ${res.runsCreated}`)
        isSorted(outPath, 0, RS, KS, N)
        // runs should have been deleted (keepRuns=false default)
        const runsLeft = fs.readdirSync(path.join(TMP_DIR, 'b-tmp'))
        assert.strictEqual(runsLeft.length, 0, 'run files not cleaned up')
        console.log('[smoke/external-sort] case B multi-run (10 runs) OK')
    }

    // Case C: preserveHeader
    {
        const RS = 20, KS = 12, N = 2000, HS = 64
        const header  = Buffer.alloc(HS)
        Buffer.from('XCHNOUT1').copy(header, 0)
        header.writeUInt8(99, 8)
        header.writeUInt32LE(N, 20)
        const records = buildRandomRecords(N, RS, 7)
        const inPath  = path.join(TMP_DIR, 'c.in')
        const outPath = path.join(TMP_DIR, 'c.out')
        fs.writeFileSync(inPath, Buffer.concat([header, records]))

        const res = await externalSort({
            inputPath: inPath, outputPath: outPath,
            headerSize: HS, recordSize: RS, keySize: KS,
            ramBudgetBytes: 500 * RS, // 4 runs
            tmpDir: path.join(TMP_DIR, 'c-tmp'),
            preserveHeader: true,
        })
        assert.strictEqual(res.recordsSorted, N)
        assert.strictEqual(res.runsCreated, 4)

        const outBuf = fs.readFileSync(outPath)
        assert.strictEqual(outBuf.length, HS + N * RS)
        assert.strictEqual(outBuf.slice(0, HS).compare(header), 0, 'header not preserved byte-exact')
        isSorted(outPath, HS, RS, KS, N)
        console.log('[smoke/external-sort] case C preserveHeader OK')
    }

    // Case D: keepRuns retains intermediate files
    {
        const RS = 20, KS = 12, N = 600
        const records = buildRandomRecords(N, RS, 999)
        const inPath  = path.join(TMP_DIR, 'd.in')
        const outPath = path.join(TMP_DIR, 'd.out')
        const tmpD   = path.join(TMP_DIR, 'd-tmp')
        fs.writeFileSync(inPath, records)
        await externalSort({
            inputPath: inPath, outputPath: outPath,
            recordSize: RS, keySize: KS,
            ramBudgetBytes: 200 * RS,
            tmpDir: tmpD, keepRuns: true,
        })
        const runs = fs.readdirSync(tmpD)
        assert.strictEqual(runs.length, 3, `expected 3 runs retained, got ${runs.length}`)
        console.log('[smoke/external-sort] case D keepRuns OK')
    }

    // Case E: empty input
    {
        const RS = 20, KS = 12
        const inPath  = path.join(TMP_DIR, 'e.in')
        const outPath = path.join(TMP_DIR, 'e.out')
        fs.writeFileSync(inPath, Buffer.alloc(0))
        const res = await externalSort({
            inputPath: inPath, outputPath: outPath,
            recordSize: RS, keySize: KS,
            ramBudgetBytes: 1024,
            tmpDir: path.join(TMP_DIR, 'e-tmp'),
        })
        assert.strictEqual(res.recordsSorted, 0)
        assert.strictEqual(res.runsCreated, 0)
        assert.strictEqual(fs.statSync(outPath).size, 0)
        console.log('[smoke/external-sort] case E empty input OK')
    }

    // Case F: misaligned input size → must throw
    {
        const inPath  = path.join(TMP_DIR, 'f.in')
        const outPath = path.join(TMP_DIR, 'f.out')
        fs.writeFileSync(inPath, Buffer.alloc(47)) // not a multiple of 20
        let caught
        try {
            await externalSort({
                inputPath: inPath, outputPath: outPath,
                recordSize: 20, keySize: 12,
                ramBudgetBytes: 1024,
                tmpDir: path.join(TMP_DIR, 'f-tmp'),
            })
        } catch (e) { caught = e }
        assert.ok(caught, 'misaligned input should throw')
        assert.match(caught.message, /not a multiple of recordSize/)
        console.log('[smoke/external-sort] case F misaligned input rejected')
    }

    // Case G: stability-ish (sort is key-only; equal keys may reorder).
    // We verify only that the output is a permutation with keys sorted.
    {
        const RS = 20, KS = 4, N = 3000 // 32-bit keys → lots of collisions
        const records = buildRandomRecords(N, RS, 31337)
        const inPath  = path.join(TMP_DIR, 'g.in')
        const outPath = path.join(TMP_DIR, 'g.out')
        fs.writeFileSync(inPath, records)
        await externalSort({
            inputPath: inPath, outputPath: outPath,
            recordSize: RS, keySize: KS,
            ramBudgetBytes: 500 * RS,
            tmpDir: path.join(TMP_DIR, 'g-tmp'),
        })
        isSorted(outPath, 0, RS, KS, N)

        // Record-body multiset equality: sort both input and output as whole
        // records and compare. Simpler: hash the concatenation of sorted whole
        // records.
        const sortRecords = (buf) => {
            const idx = Array.from({ length: N }, (_, i) => i)
            idx.sort((a, b) => Buffer.compare(
                buf.subarray(a * RS, (a + 1) * RS),
                buf.subarray(b * RS, (b + 1) * RS),
            ))
            const out = Buffer.alloc(N * RS)
            for (let i = 0; i < N; i++) buf.copy(out, i * RS, idx[i] * RS, (idx[i] + 1) * RS)
            return crypto.createHash('sha256').update(out).digest('hex')
        }
        const inHash  = sortRecords(records)
        const outHash = sortRecords(fs.readFileSync(outPath))
        assert.strictEqual(inHash, outHash, 'output is not a permutation of input (lost or duplicated records)')
        console.log('[smoke/external-sort] case G multiset identity OK')
    }

    fs.rmSync(TMP_DIR, { recursive: true, force: true })
    console.log('[smoke/external-sort] all checks passed')
}

main().catch(err => {
    console.error('[smoke/external-sort] FAIL:', err)
    process.exit(1)
})
