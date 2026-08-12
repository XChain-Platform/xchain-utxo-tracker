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

// Ad-hoc smoke test for derive-keys.js. Builds a tiny synthetic scenario,
// runs the full pipeline (external-sort outputs & spends → left-anti-join →
// derive-keys) and asserts the per-prefix counts and a handful of specific
// records.
//
// Scenario:
//   Block 0 (h=0, hash=H0): tx T0 with 2 outputs
//     vout 0 → scriptX, value 100
//     vout 1 → scriptY, value 200
//   Block 1 (h=1, hash=H1, prev=H0): tx T1 spends T0:0, produces 1 output
//     vout 0 → scriptZ, value 100
//
// Expectations:
//   B=2  T=2  N=2 (window)  I=1  J=1  O=2 (live)  H=2 (live)
//   S=3 (X, Y, Z; X is fully spent but we use pre-cancellation outputs)
//   Z=3
//   L: LAST_BLOCK_HEIGHT='1', LAST_BLOCK_HASH=H1.hex
//
// The live UTXOs are T0:1 (scriptY) and T1:0 (scriptZ).

const fs     = require('fs')
const os     = require('os')
const path   = require('path')
const assert = require('assert')

const { OutputsWriter,
        SpendsWriter,
        MetaWriter }     = require('../writers.js')
const { externalSort }   = require('./external-sort.js')
const { leftAntiJoin }   = require('./streaming-join.js')
const { deriveKeys,
        LAYOUT }         = require('./derive-keys.js')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-derive-keys-'))
console.log('[smoke/derive-keys] tmp dir:', TMP)

function hashBuf(tag) {
    const b = Buffer.alloc(32, 0)
    Buffer.from(tag, 'utf8').copy(b, 0)
    return b
}
function scriptBuf(tag) {
    const b = Buffer.alloc(32, 0)
    Buffer.from(tag, 'utf8').copy(b, 0)
    return b
}
function txh8(full) { return full.subarray(0, 8) }

const H0     = hashBuf('block0')
const H1     = hashBuf('block1')
const PREV0  = Buffer.alloc(32, 0)
const T0_FULL = hashBuf('tx_zero______')
const T1_FULL = hashBuf('tx_one_______')
const T0_8    = txh8(T0_FULL)
const T1_8    = txh8(T1_FULL)
const SCRIPT_X = scriptBuf('script_X')
const SCRIPT_Y = scriptBuf('script_Y')
const SCRIPT_Z = scriptBuf('script_Z')

async function main() {
    fs.rmSync(TMP, { recursive: true, force: true })
    fs.mkdirSync(TMP)

    const outputsPath = path.join(TMP, 'outputs.dat')
    const spendsPath  = path.join(TMP, 'spends.dat')
    const metaPath    = path.join(TMP, 'meta.dat')

    // Write synthetic parse-worker outputs
    {
        const w = new OutputsWriter(outputsPath, 'bitcoin', 'regtest', 0, 1)
        w.append(T0_8, 0, 100n, 0, T0_FULL, SCRIPT_X, H0)
        w.append(T0_8, 1, 200n, 0, T0_FULL, SCRIPT_Y, H0)
        w.append(T1_8, 0, 100n, 1, T1_FULL, SCRIPT_Z, H1)
        w.close()
    }
    {
        const w = new SpendsWriter(spendsPath, 'bitcoin', 'regtest', 0, 1)
        w.append(T0_8, 0, T1_8)
        w.close()
    }
    {
        const w = new MetaWriter(metaPath, 'bitcoin', 'regtest', 0, 1)
        w.writeBlock(0, 1_700_000_000, H0, PREV0, [T0_8])
        w.writeBlock(1, 1_700_000_600, H1, H0,    [T1_8])
        w.close()
    }

    // External-sort outputs and spends
    const outputsByTx     = path.join(TMP, 'outputs-by-tx.dat')
    const spendsByPrevTx  = path.join(TMP, 'spends-by-prevtx.dat')
    const sortTmp         = path.join(TMP, 'sort-tmp')
    fs.mkdirSync(sortTmp)

    await externalSort({
        inputPath: outputsPath, outputPath: outputsByTx,
        headerSize: 64, recordSize: 121, keySize: 12,
        ramBudgetBytes: 1024 * 1024, tmpDir: path.join(sortTmp, 'o'),
    })
    await externalSort({
        inputPath: spendsPath, outputPath: spendsByPrevTx,
        headerSize: 64, recordSize: 20, keySize: 12,
        ramBudgetBytes: 1024 * 1024, tmpDir: path.join(sortTmp, 's'),
    })

    // Left-anti-join → live-utxos
    const liveUtxos = path.join(TMP, 'live-utxos.dat')
    const joinRes = await leftAntiJoin({
        leftPath: outputsByTx, rightPath: spendsByPrevTx, outputPath: liveUtxos,
        leftRecordSize: 121, rightRecordSize: 20, keySize: 12,
    })
    assert.strictEqual(joinRes.emitted, 2, 'expected 2 live UTXOs')
    assert.strictEqual(joinRes.canceled, 1)
    assert.strictEqual(joinRes.orphanSpends, 0)

    // Derive keys
    const outDir = path.join(TMP, 'keys')
    const derTmp = path.join(TMP, 'derive-tmp')
    const { stats } = await deriveKeys({
        metaPath, outputsPath, liveUtxosPath: liveUtxos, spendsByPrevPath: spendsByPrevTx,
        outDir, tmpDir: derTmp,
        ramBudgetBytes: 1024 * 1024,
        outputsRecordSize: 121,
    })

    // Asserts: counts per prefix
    assert.strictEqual(stats.B, 2, 'B count')
    assert.strictEqual(stats.T, 2, 'T count')
    assert.strictEqual(stats.N, 2, 'N count (window of 10, only 2 blocks)')
    assert.strictEqual(stats.I, 1, 'I count')
    assert.strictEqual(stats.J, 1, 'J count')
    assert.strictEqual(stats.O, 2, 'O count')
    assert.strictEqual(stats.H, 2, 'H count')
    assert.strictEqual(stats.S, 3, 'S count: X, Y, Z (option A preserves fully-spent scripts)')
    assert.strictEqual(stats.Z, 3, 'Z count')

    // File sizes match layout.recordSize × count
    const fileSize = (name) => fs.statSync(path.join(outDir, name)).size
    assert.strictEqual(fileSize('B.dat'), stats.B * LAYOUT.B.recordSize)
    assert.strictEqual(fileSize('T.dat'), stats.T * LAYOUT.T.recordSize)
    assert.strictEqual(fileSize('I.dat'), stats.I * LAYOUT.I.recordSize)
    assert.strictEqual(fileSize('J.dat'), stats.J * LAYOUT.J.recordSize)
    assert.strictEqual(fileSize('O.dat'), stats.O * LAYOUT.O.recordSize)
    assert.strictEqual(fileSize('H.dat'), stats.H * LAYOUT.H.recordSize)
    assert.strictEqual(fileSize('S.dat'), stats.S * LAYOUT.S.recordSize)
    assert.strictEqual(fileSize('Z.dat'), stats.Z * LAYOUT.Z.recordSize)
    assert.strictEqual(fileSize('N.dat'), stats.N * LAYOUT.N.recordSize)
    console.log('[smoke/derive-keys] counts + sizes OK')

    // Sorted-ness: each prefix file must be ascending by key
    for (const p of Object.keys(LAYOUT)) {
        const { keySize, recordSize } = LAYOUT[p]
        const buf = fs.readFileSync(path.join(outDir, p + '.dat'))
        for (let i = recordSize; i < buf.length; i += recordSize) {
            const a = buf.subarray(i - recordSize, i - recordSize + keySize)
            const b = buf.subarray(i,              i + keySize)
            assert.ok(Buffer.compare(a, b) <= 0, `${p}.dat out of order at record ${i / recordSize}`)
        }
    }
    console.log('[smoke/derive-keys] sort order OK')

    // Specific records
    const B = fs.readFileSync(path.join(outDir, 'B.dat'))
    // Find the B record for block H0; verify height=0, ts=..., prev=zero.
    function findB(hash) {
        const rs = LAYOUT.B.recordSize
        for (let i = 0; i < B.length; i += rs) {
            if (B[i] !== 0x42) continue
            if (B.subarray(i + 1, i + 33).compare(hash) === 0) return i
        }
        return -1
    }
    {
        const off = findB(H0)
        assert.ok(off >= 0)
        assert.strictEqual(B.readUInt32BE(off + 33),     0,         'B[H0] height')
        assert.strictEqual(B.readUInt32BE(off + 37),     1_700_000_000, 'B[H0] ts')
        assert.strictEqual(B.subarray(off + 41, off + 73).compare(PREV0), 0, 'B[H0] prevHash')
    }
    {
        const off = findB(H1)
        assert.ok(off >= 0)
        assert.strictEqual(B.readUInt32BE(off + 33), 1, 'B[H1] height')
        assert.strictEqual(B.subarray(off + 41, off + 73).compare(H0), 0, 'B[H1] prevHash')
    }

    // S contains scriptX even though it's fully spent
    const S = fs.readFileSync(path.join(outDir, 'S.dat'))
    function findS(script) {
        const rs = LAYOUT.S.recordSize
        for (let i = 0; i < S.length; i += rs) {
            if (S.subarray(i + 1, i + 33).compare(script) === 0) return i
        }
        return -1
    }
    {
        const off = findS(SCRIPT_X)
        assert.ok(off >= 0, 'S must contain fully-spent scriptX (option A)')
        assert.strictEqual(S.readUInt32BE(off + 33), 0, 'S[X] height=0')
    }
    assert.ok(findS(SCRIPT_Y) >= 0, 'S must contain scriptY')
    assert.ok(findS(SCRIPT_Z) >= 0, 'S must contain scriptZ')
    console.log('[smoke/derive-keys] option A: fully-spent scriptX present in S.dat OK')

    // Z has matching (blockHash, scriptHash) pairs
    const Z = fs.readFileSync(path.join(outDir, 'Z.dat'))
    function hasZ(blockHash, script) {
        const rs = LAYOUT.Z.recordSize
        for (let i = 0; i < Z.length; i += rs) {
            if (Z.subarray(i + 1, i + 33).compare(blockHash) !== 0) continue
            if (Z.subarray(i + 33, i + 65).compare(script)   !== 0) continue
            return true
        }
        return false
    }
    assert.ok(hasZ(H0, SCRIPT_X), 'Z[H0, X]')
    assert.ok(hasZ(H0, SCRIPT_Y), 'Z[H0, Y]')
    assert.ok(hasZ(H1, SCRIPT_Z), 'Z[H1, Z]')

    // I has the one spend: I[T0,0] = T1_8
    const I = fs.readFileSync(path.join(outDir, 'I.dat'))
    assert.strictEqual(I[0], 0x49)
    assert.strictEqual(I.subarray(1, 9).compare(T0_8), 0, 'I key prevTxHash8')
    assert.strictEqual(I.readUInt32BE(9), 0, 'I key prevVout')
    assert.strictEqual(I.subarray(13, 21).compare(T1_8), 0, 'I val spenderTxHash8')

    // J has the one matching input-hint: J[T1, T0, 0]
    const J = fs.readFileSync(path.join(outDir, 'J.dat'))
    assert.strictEqual(J[0], 0x4A)
    assert.strictEqual(J.subarray(1, 9)  .compare(T1_8), 0, 'J key spenderTxHash8')
    assert.strictEqual(J.subarray(9, 17) .compare(T0_8), 0, 'J key prevTxHash8')
    assert.strictEqual(J.readUInt32BE(17),                0, 'J key prevVout')

    // H records for live UTXOs only
    const H = fs.readFileSync(path.join(outDir, 'H.dat'))
    function hasH(txHash8, vout) {
        const rs = LAYOUT.H.recordSize
        for (let i = 0; i < H.length; i += rs) {
            if (H.subarray(i + 1, i + 9).compare(txHash8) !== 0) continue
            if (H.readUInt32BE(i + 9) !== vout) continue
            return i
        }
        return -1
    }
    assert.strictEqual(hasH(T0_8, 0), -1, 'H must NOT contain the spent output T0:0')
    assert.ok(hasH(T0_8, 1) >= 0, 'H must contain T0:1')
    assert.ok(hasH(T1_8, 0) >= 0, 'H must contain T1:0')
    {
        const off = hasH(T0_8, 1)
        assert.strictEqual(H.subarray(off + 13, off + 45).compare(SCRIPT_Y), 0, 'H[T0:1] scriptY')
    }

    // O records for live UTXOs with expected values
    const O = fs.readFileSync(path.join(outDir, 'O.dat'))
    function findO(script, txHash8, vout) {
        const rs = LAYOUT.O.recordSize
        for (let i = 0; i < O.length; i += rs) {
            if (O.subarray(i + 1,  i + 33).compare(script)  !== 0) continue
            if (O.subarray(i + 33, i + 41).compare(txHash8) !== 0) continue
            if (O.readUInt32BE(i + 41) !== vout) continue
            return i
        }
        return -1
    }
    {
        const off = findO(SCRIPT_Y, T0_8, 1)
        assert.ok(off >= 0)
        assert.strictEqual(O.readBigUInt64BE(off + 45), 200n, 'O[Y,T0,1] value')
        assert.strictEqual(O.readInt32BE(off + 53),     0,    'O[Y,T0,1] height')
        assert.strictEqual(O.subarray(off + 57, off + 89).compare(T0_FULL), 0, 'O[Y,T0,1] fullTx')
    }
    {
        const off = findO(SCRIPT_Z, T1_8, 0)
        assert.ok(off >= 0)
        assert.strictEqual(O.readBigUInt64BE(off + 45), 100n)
        assert.strictEqual(O.readInt32BE(off + 53),     1)
    }
    assert.strictEqual(findO(SCRIPT_X, T0_8, 0), -1, 'O must NOT contain spent X')

    // T records
    const T = fs.readFileSync(path.join(outDir, 'T.dat'))
    function findT(txHash8) {
        const rs = LAYOUT.T.recordSize
        for (let i = 0; i < T.length; i += rs) {
            if (T.subarray(i + 1, i + 9).compare(txHash8) === 0) return i
        }
        return -1
    }
    {
        const off = findT(T0_8)
        assert.ok(off >= 0)
        assert.strictEqual(T.subarray(off + 9, off + 41).compare(H0), 0, 'T[T0] blockHash=H0')
    }
    {
        const off = findT(T1_8)
        assert.strictEqual(T.subarray(off + 9, off + 41).compare(H1), 0, 'T[T1] blockHash=H1')
    }

    // N window has both blocks
    const N = fs.readFileSync(path.join(outDir, 'N.dat'))
    function hasN(hash) {
        const rs = LAYOUT.N.recordSize
        for (let i = 0; i < N.length; i += rs) {
            if (N.subarray(i + 1, i + 33).compare(hash) === 0) return true
        }
        return false
    }
    assert.ok(hasN(H0))
    assert.ok(hasN(H1))

    // L.json
    const L = JSON.parse(fs.readFileSync(path.join(outDir, 'L.json'), 'utf8'))
    assert.strictEqual(L.LAST_BLOCK_HEIGHT, '1') // 1 in hex = "1"
    assert.strictEqual(L.LAST_BLOCK_HASH, H1.toString('hex'))

    console.log('[smoke/derive-keys] all checks passed')

    fs.rmSync(TMP, { recursive: true, force: true })
}

main().catch(err => {
    console.error('[smoke/derive-keys] FAIL:', err)
    process.exit(1)
})
