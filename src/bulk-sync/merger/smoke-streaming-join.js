'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

// Ad-hoc smoke test for streaming-join.js. Covers:
//   - Pure no-cancellation (all left emitted)
//   - Full cancellation (every left key appears in right)
//   - Partial cancellation (mixed)
//   - Orphan spends (right keys not in left)
//   - Empty left
//   - Empty right
//   - copyLeftHeader preserves first N bytes
//   - Duplicate keys on left (surplus emitted)
//   - Duplicate keys on right (surplus counted as orphan)

const fs     = require('fs')
const os     = require('os')
const path   = require('path')
const assert = require('assert')

const { leftAntiJoin } = require('./streaming-join.js')

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-stream-join-'))
console.log('[smoke/streaming-join] tmp dir:', TMP_DIR)

// Build a left-side file: records of `leftRecordSize` bytes, key = first
// `keySize` bytes (BE encoded u32 for convenience in tests).
function buildRecords(keys, recordSize, keySize, headerBytes = null, payloadFn = null) {
    const headerLen = headerBytes ? headerBytes.length : 0
    const buf = Buffer.alloc(headerLen + keys.length * recordSize)
    if (headerBytes) headerBytes.copy(buf, 0)
    for (let i = 0; i < keys.length; i++) {
        const off = headerLen + i * recordSize
        // Key: BE u32 in first keySize bytes (pad with zero if keySize > 4).
        buf.writeUInt32BE(keys[i] >>> 0, off + keySize - 4)
        // Payload: optional per-record bytes after the key.
        if (payloadFn) {
            const pl = payloadFn(i, keys[i])
            pl.copy(buf, off + keySize)
        }
    }
    return buf
}

function readRecords(filePath, headerSize, recordSize) {
    const full = fs.readFileSync(filePath)
    const data = full.subarray(headerSize)
    assert.strictEqual(data.length % recordSize, 0, `output size ${data.length} not multiple of ${recordSize}`)
    const n = data.length / recordSize
    const out = []
    for (let i = 0; i < n; i++) {
        out.push(data.subarray(i * recordSize, (i + 1) * recordSize))
    }
    return out
}

function keyU32(rec, keySize) {
    return rec.readUInt32BE(keySize - 4)
}

async function main() {
    fs.rmSync(TMP_DIR, { recursive: true, force: true })
    fs.mkdirSync(TMP_DIR)

    const LRS = 16, RRS = 12, KS = 8

    // ---- Case A: pure no-cancellation (right empty, all left emitted) ----
    {
        const leftKeys  = [1, 5, 9, 13, 17]
        const rightKeys = []
        const leftPath  = path.join(TMP_DIR, 'a.left')
        const rightPath = path.join(TMP_DIR, 'a.right')
        const outPath   = path.join(TMP_DIR, 'a.out')
        fs.writeFileSync(leftPath,  buildRecords(leftKeys,  LRS, KS))
        fs.writeFileSync(rightPath, buildRecords(rightKeys, RRS, KS))
        const res = await leftAntiJoin({
            leftPath, rightPath, outputPath: outPath,
            leftRecordSize: LRS, rightRecordSize: RRS, keySize: KS,
        })
        assert.strictEqual(res.leftRead, 5)
        assert.strictEqual(res.rightRead, 0)
        assert.strictEqual(res.emitted, 5)
        assert.strictEqual(res.canceled, 0)
        assert.strictEqual(res.orphanSpends, 0)
        const recs = readRecords(outPath, 0, LRS)
        assert.deepStrictEqual(recs.map(r => keyU32(r, KS)), leftKeys)
        console.log('[smoke/streaming-join] case A pure no-cancellation OK')
    }

    // ---- Case B: full cancellation (every left key in right) ----
    {
        const leftKeys  = [1, 5, 9, 13, 17]
        const rightKeys = [1, 5, 9, 13, 17]
        const leftPath  = path.join(TMP_DIR, 'b.left')
        const rightPath = path.join(TMP_DIR, 'b.right')
        const outPath   = path.join(TMP_DIR, 'b.out')
        fs.writeFileSync(leftPath,  buildRecords(leftKeys,  LRS, KS))
        fs.writeFileSync(rightPath, buildRecords(rightKeys, RRS, KS))
        const res = await leftAntiJoin({
            leftPath, rightPath, outputPath: outPath,
            leftRecordSize: LRS, rightRecordSize: RRS, keySize: KS,
        })
        assert.strictEqual(res.leftRead, 5)
        assert.strictEqual(res.rightRead, 5)
        assert.strictEqual(res.emitted, 0)
        assert.strictEqual(res.canceled, 5)
        assert.strictEqual(res.orphanSpends, 0)
        assert.strictEqual(fs.statSync(outPath).size, 0)
        console.log('[smoke/streaming-join] case B full cancellation OK')
    }

    // ---- Case C: partial cancellation + orphan spends ----
    {
        // left  keys: 1, 3, 5, 7, 9, 11
        // right keys: 2, 3, 4, 7, 10   (2, 4, 10 = orphans; 3, 7 = canceled)
        // expected emitted: 1, 5, 9, 11; canceled=2, orphans=3
        const leftKeys  = [1, 3, 5, 7, 9, 11]
        const rightKeys = [2, 3, 4, 7, 10]
        const leftPath  = path.join(TMP_DIR, 'c.left')
        const rightPath = path.join(TMP_DIR, 'c.right')
        const outPath   = path.join(TMP_DIR, 'c.out')
        fs.writeFileSync(leftPath,  buildRecords(leftKeys,  LRS, KS))
        fs.writeFileSync(rightPath, buildRecords(rightKeys, RRS, KS))
        const anomalies = []
        const res = await leftAntiJoin({
            leftPath, rightPath, outputPath: outPath,
            leftRecordSize: LRS, rightRecordSize: RRS, keySize: KS,
            onAnomaly: (a) => anomalies.push(a),
        })
        assert.strictEqual(res.emitted, 4)
        assert.strictEqual(res.canceled, 2)
        assert.strictEqual(res.orphanSpends, 3)
        const recs = readRecords(outPath, 0, LRS)
        assert.deepStrictEqual(recs.map(r => keyU32(r, KS)), [1, 5, 9, 11])
        assert.strictEqual(anomalies.length, 3)
        assert.deepStrictEqual(
            anomalies.map(a => a.key.readUInt32BE(KS - 4)),
            [2, 4, 10],
        )
        console.log('[smoke/streaming-join] case C partial cancellation + orphans OK')
    }

    // ---- Case D: empty left ----
    {
        const leftPath  = path.join(TMP_DIR, 'd.left')
        const rightPath = path.join(TMP_DIR, 'd.right')
        const outPath   = path.join(TMP_DIR, 'd.out')
        fs.writeFileSync(leftPath,  Buffer.alloc(0))
        fs.writeFileSync(rightPath, buildRecords([1, 2, 3], RRS, KS))
        const res = await leftAntiJoin({
            leftPath, rightPath, outputPath: outPath,
            leftRecordSize: LRS, rightRecordSize: RRS, keySize: KS,
        })
        assert.strictEqual(res.leftRead, 0)
        assert.strictEqual(res.rightRead, 3)
        assert.strictEqual(res.emitted, 0)
        assert.strictEqual(res.orphanSpends, 3)
        assert.strictEqual(fs.statSync(outPath).size, 0)
        console.log('[smoke/streaming-join] case D empty left OK')
    }

    // ---- Case E: empty right ----
    {
        const leftPath  = path.join(TMP_DIR, 'e.left')
        const rightPath = path.join(TMP_DIR, 'e.right')
        const outPath   = path.join(TMP_DIR, 'e.out')
        fs.writeFileSync(leftPath,  buildRecords([1, 2, 3], LRS, KS))
        fs.writeFileSync(rightPath, Buffer.alloc(0))
        const res = await leftAntiJoin({
            leftPath, rightPath, outputPath: outPath,
            leftRecordSize: LRS, rightRecordSize: RRS, keySize: KS,
        })
        assert.strictEqual(res.leftRead, 3)
        assert.strictEqual(res.rightRead, 0)
        assert.strictEqual(res.emitted, 3)
        assert.strictEqual(res.orphanSpends, 0)
        assert.strictEqual(fs.statSync(outPath).size, 3 * LRS)
        console.log('[smoke/streaming-join] case E empty right OK')
    }

    // ---- Case F: copyLeftHeader preserves header bytes ----
    {
        const HS = 64
        const header = Buffer.alloc(HS)
        Buffer.from('XCHNOUT1').copy(header, 0)
        header.writeUInt32LE(0xdeadbeef, 8)
        header.writeUInt32LE(12345, 20)

        const leftKeys  = [10, 20, 30]
        const rightKeys = [20]
        const leftPath  = path.join(TMP_DIR, 'f.left')
        const rightPath = path.join(TMP_DIR, 'f.right')
        const outPath   = path.join(TMP_DIR, 'f.out')
        fs.writeFileSync(leftPath,  buildRecords(leftKeys,  LRS, KS, header))
        fs.writeFileSync(rightPath, buildRecords(rightKeys, RRS, KS))

        const res = await leftAntiJoin({
            leftPath, rightPath, outputPath: outPath,
            leftHeaderSize: HS, leftRecordSize: LRS,
            rightRecordSize: RRS, keySize: KS,
            copyLeftHeader: true,
        })
        assert.strictEqual(res.emitted, 2)
        assert.strictEqual(res.canceled, 1)

        const outBuf = fs.readFileSync(outPath)
        assert.strictEqual(outBuf.length, HS + 2 * LRS)
        assert.strictEqual(outBuf.subarray(0, HS).compare(header), 0, 'header not preserved')
        const recs = readRecords(outPath, HS, LRS)
        assert.deepStrictEqual(recs.map(r => keyU32(r, KS)), [10, 30])
        console.log('[smoke/streaming-join] case F copyLeftHeader OK')
    }

    // ---- Case G: distinct payloads carried through verbatim ----
    {
        const leftKeys  = [100, 200, 300]
        const rightKeys = [200]
        const payloadFn = (i) => {
            const b = Buffer.alloc(LRS - KS)
            b.writeUInt32BE((0xaabbcc00 | i) >>> 0, 0)
            return b
        }
        const leftPath  = path.join(TMP_DIR, 'g.left')
        const rightPath = path.join(TMP_DIR, 'g.right')
        const outPath   = path.join(TMP_DIR, 'g.out')
        fs.writeFileSync(leftPath,  buildRecords(leftKeys,  LRS, KS, null, payloadFn))
        fs.writeFileSync(rightPath, buildRecords(rightKeys, RRS, KS))

        const res = await leftAntiJoin({
            leftPath, rightPath, outputPath: outPath,
            leftRecordSize: LRS, rightRecordSize: RRS, keySize: KS,
        })
        assert.strictEqual(res.emitted, 2)
        const recs = readRecords(outPath, 0, LRS)
        // Left indices that survived: 0 (key=100) and 2 (key=300) → payloads aabbcc00, aabbcc02.
        assert.strictEqual(recs[0].readUInt32BE(KS), 0xaabbcc00)
        assert.strictEqual(recs[1].readUInt32BE(KS), 0xaabbcc02)
        console.log('[smoke/streaming-join] case G payload integrity OK')
    }

    // ---- Case H: duplicate keys on left (surplus emitted) ----
    {
        // left:  1, 5, 5, 5, 9   right: 5
        // one pairing: one 5 canceled, two extra 5s emitted with 1 and 9.
        // expected emitted: 1, 5, 5, 9; canceled=1; orphanSpends=0.
        const leftKeys  = [1, 5, 5, 5, 9]
        const rightKeys = [5]
        const leftPath  = path.join(TMP_DIR, 'h.left')
        const rightPath = path.join(TMP_DIR, 'h.right')
        const outPath   = path.join(TMP_DIR, 'h.out')
        fs.writeFileSync(leftPath,  buildRecords(leftKeys,  LRS, KS))
        fs.writeFileSync(rightPath, buildRecords(rightKeys, RRS, KS))

        const res = await leftAntiJoin({
            leftPath, rightPath, outputPath: outPath,
            leftRecordSize: LRS, rightRecordSize: RRS, keySize: KS,
        })
        assert.strictEqual(res.emitted, 4)
        assert.strictEqual(res.canceled, 1)
        assert.strictEqual(res.orphanSpends, 0)
        const recs = readRecords(outPath, 0, LRS)
        assert.deepStrictEqual(recs.map(r => keyU32(r, KS)), [1, 5, 5, 9])
        console.log('[smoke/streaming-join] case H duplicate left keys OK')
    }

    // ---- Case I: duplicate keys on right (surplus counted as orphan) ----
    {
        // left:  1, 5, 9   right: 5, 5, 5
        // first 5 cancels; remaining two 5s are orphan spends.
        const leftKeys  = [1, 5, 9]
        const rightKeys = [5, 5, 5]
        const leftPath  = path.join(TMP_DIR, 'i.left')
        const rightPath = path.join(TMP_DIR, 'i.right')
        const outPath   = path.join(TMP_DIR, 'i.out')
        fs.writeFileSync(leftPath,  buildRecords(leftKeys,  LRS, KS))
        fs.writeFileSync(rightPath, buildRecords(rightKeys, RRS, KS))

        const res = await leftAntiJoin({
            leftPath, rightPath, outputPath: outPath,
            leftRecordSize: LRS, rightRecordSize: RRS, keySize: KS,
        })
        assert.strictEqual(res.emitted, 2)
        assert.strictEqual(res.canceled, 1)
        assert.strictEqual(res.orphanSpends, 2)
        const recs = readRecords(outPath, 0, LRS)
        assert.deepStrictEqual(recs.map(r => keyU32(r, KS)), [1, 9])
        console.log('[smoke/streaming-join] case I duplicate right keys OK')
    }

    fs.rmSync(TMP_DIR, { recursive: true, force: true })
    console.log('[smoke/streaming-join] all checks passed')
}

main().catch(err => {
    console.error('[smoke/streaming-join] FAIL:', err)
    process.exit(1)
})
