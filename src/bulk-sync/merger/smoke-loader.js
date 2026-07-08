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

// Ad-hoc smoke test for loader.js. Builds a tiny keysDir, loads it into
// a fresh classic-level (LevelDB) DB, reads back via db.get() and asserts
// that keys/values round-trip byte-for-byte.

const fs     = require('fs')
const os     = require('os')
const path   = require('path')
const assert = require('assert')

const { loadKeys } = require('./loader.js')
const { LAYOUT }   = require('./derive-keys.js')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-loader-'))
console.log('[smoke/loader] tmp dir:', TMP)

function buildFile(filePath, records) {
    const buf = Buffer.concat(records)
    fs.writeFileSync(filePath, buf)
}

function rec(key, value) {
    if (value.length === 0) return key
    return Buffer.concat([key, value])
}

function kB(blockHash) {
    const b = Buffer.alloc(33); b[0] = 0x42; blockHash.copy(b, 1); return b
}
function kT(txh8) {
    const b = Buffer.alloc(9); b[0] = 0x54; txh8.copy(b, 1); return b
}
function kI(prevTxh8, vout) {
    const b = Buffer.alloc(13); b[0] = 0x49; prevTxh8.copy(b, 1); b.writeUInt32BE(vout, 9); return b
}
function kJ(spenderTxh8, prevTxh8, vout) {
    const b = Buffer.alloc(21); b[0] = 0x4A
    spenderTxh8.copy(b, 1); prevTxh8.copy(b, 9); b.writeUInt32BE(vout, 17)
    return b
}
function kN(blockHash) {
    const b = Buffer.alloc(33); b[0] = 0x4E; blockHash.copy(b, 1); return b
}
function kO(script, txh8, vout) {
    const b = Buffer.alloc(45); b[0] = 0x4F
    script.copy(b, 1); txh8.copy(b, 33); b.writeUInt32BE(vout, 41)
    return b
}
function kH(txh8, vout) {
    const b = Buffer.alloc(13); b[0] = 0x48; txh8.copy(b, 1); b.writeUInt32BE(vout, 9); return b
}
function kS(script) {
    const b = Buffer.alloc(33); b[0] = 0x53; script.copy(b, 1); return b
}
function kZ(blockHash, script) {
    const b = Buffer.alloc(65); b[0] = 0x5A; blockHash.copy(b, 1); script.copy(b, 33); return b
}

async function main() {
    const keysDir = path.join(TMP, 'keys')
    const dbPath  = path.join(TMP, 'db')
    fs.mkdirSync(keysDir)

    const H0     = Buffer.alloc(32, 0); Buffer.from('block0').copy(H0, 0)
    const H1     = Buffer.alloc(32, 0); Buffer.from('block1').copy(H1, 0)
    const PREV0  = Buffer.alloc(32, 0)
    const T0_FULL= Buffer.alloc(32, 0); Buffer.from('tx_zero').copy(T0_FULL, 0)
    const T1_FULL= Buffer.alloc(32, 0); Buffer.from('tx_one').copy(T1_FULL, 0)
    const T0_8   = T0_FULL.subarray(0, 8)
    const T1_8   = T1_FULL.subarray(0, 8)
    const SX     = Buffer.alloc(32, 0); Buffer.from('scriptX').copy(SX, 0)
    const SY     = Buffer.alloc(32, 0); Buffer.from('scriptY').copy(SY, 0)

    // Assemble per-prefix files sorted by key ascending.
    function val(bytes) { return Buffer.from(bytes) }

    // B: 2 blocks
    const bVal0 = Buffer.alloc(40)
    bVal0.writeUInt32BE(0, 0); bVal0.writeUInt32BE(1_700_000_000, 4); PREV0.copy(bVal0, 8)
    const bVal1 = Buffer.alloc(40)
    bVal1.writeUInt32BE(1, 0); bVal1.writeUInt32BE(1_700_000_600, 4); H0.copy(bVal1, 8)
    const bRecs = [[kB(H0), bVal0], [kB(H1), bVal1]]
        .sort((a, b) => Buffer.compare(a[0], b[0]))
        .map(([k, v]) => rec(k, v))
    buildFile(path.join(keysDir, 'B.dat'), bRecs)

    // T: T0 in H0, T1 in H1
    const tRecs = [[kT(T0_8), H0], [kT(T1_8), H1]]
        .sort((a, b) => Buffer.compare(a[0], b[0]))
        .map(([k, v]) => rec(k, v))
    buildFile(path.join(keysDir, 'T.dat'), tRecs)

    // I: one spend T0:0 → T1
    buildFile(path.join(keysDir, 'I.dat'), [rec(kI(T0_8, 0), T1_8)])
    // J
    buildFile(path.join(keysDir, 'J.dat'), [rec(kJ(T1_8, T0_8, 0), Buffer.alloc(0))])

    // N: just H1
    buildFile(path.join(keysDir, 'N.dat'), [rec(kN(H1), Buffer.alloc(0))])

    // O: 1 live UTXO on scriptY @ T0:1 value=200 height=0. The intermediate
    // O.dat value is 45 bytes (value8+height4+fullTxHash32+coinbase1); the loader
    // re-encodes it to the live path's on-disk form, so a non-coinbase output
    // reads back as the 44-byte oValOnDisk (the coinbase byte is dropped, L-4).
    const oValIntermediate = Buffer.alloc(45)
    oValIntermediate.writeBigUInt64BE(200n, 0)
    oValIntermediate.writeInt32BE(0, 8)
    T0_FULL.copy(oValIntermediate, 12)
    oValIntermediate[44] = 0 // non-coinbase
    const oValOnDisk = oValIntermediate.subarray(0, 44)
    buildFile(path.join(keysDir, 'O.dat'), [rec(kO(SY, T0_8, 1), oValIntermediate)])

    // H: scriptY hint on T0:1
    buildFile(path.join(keysDir, 'H.dat'), [rec(kH(T0_8, 1), SY)])

    // S: scriptX h=0, scriptY h=0. S value is the 4-byte first-seen block
    // height (LAYOUT.S.valSize === 4), matching LevelUpDb.encodeScriptBlk.
    const sValX = Buffer.alloc(4); sValX.writeUInt32BE(0, 0)
    const sValY = Buffer.alloc(4); sValY.writeUInt32BE(0, 0)
    const sRecs = [[kS(SX), sValX], [kS(SY), sValY]]
        .sort((a, b) => Buffer.compare(a[0], b[0]))
        .map(([k, v]) => rec(k, v))
    buildFile(path.join(keysDir, 'S.dat'), sRecs)

    // Z
    const zRecs = [[kZ(H0, SX), Buffer.alloc(0)], [kZ(H0, SY), Buffer.alloc(0)]]
        .sort((a, b) => Buffer.compare(a[0], b[0]))
        .map(([k, v]) => rec(k, v))
    buildFile(path.join(keysDir, 'Z.dat'), zRecs)

    // L
    fs.writeFileSync(path.join(keysDir, 'L.json'), JSON.stringify({
        LAST_BLOCK_HEIGHT: '1',
        LAST_BLOCK_HASH:   H1.toString('hex'),
    }))

    // Load into DB
    const res = await loadKeys({ keysDir, dbPath, batchSize: 100 })
    assert.strictEqual(res.stats.B, 2)
    assert.strictEqual(res.stats.T, 2)
    assert.strictEqual(res.stats.I, 1)
    assert.strictEqual(res.stats.J, 1)
    assert.strictEqual(res.stats.N, 1)
    assert.strictEqual(res.stats.O, 1)
    assert.strictEqual(res.stats.H, 1)
    assert.strictEqual(res.stats.S, 2)
    assert.strictEqual(res.stats.Z, 2)
    assert.strictEqual(res.stats.L, 2)
    console.log('[smoke/loader] load counts OK, elapsed', res.elapsed_ms, 'ms')

    // Read back some keys and verify byte-exact value.
    const { ClassicLevel } = require('classic-level')
    const db = new ClassicLevel(dbPath, { keyEncoding: 'buffer', valueEncoding: 'buffer' })
    await db.open()

    try {
        const got_B_H0 = await db.get(kB(H0))
        assert.strictEqual(Buffer.from(got_B_H0).compare(bVal0), 0, 'B[H0] round-trip')

        const got_O = await db.get(kO(SY, T0_8, 1))
        assert.strictEqual(Buffer.from(got_O).compare(oValOnDisk), 0, 'O[Y,T0,1] round-trip')

        const got_H = await db.get(kH(T0_8, 1))
        assert.strictEqual(Buffer.from(got_H).compare(SY), 0, 'H[T0:1] round-trip')

        const got_I = await db.get(kI(T0_8, 0))
        assert.strictEqual(Buffer.from(got_I).compare(T1_8), 0, 'I[T0:0] round-trip')

        const got_N = await db.get(kN(H1))
        assert.strictEqual(Buffer.from(got_N).length, 0, 'N[H1] empty value')

        const got_LH = await db.get(Buffer.from('LAST_BLOCK_HEIGHT'))
        assert.strictEqual(got_LH.toString(), '1', 'LAST_BLOCK_HEIGHT')
        const got_LB = await db.get(Buffer.from('LAST_BLOCK_HASH'))
        assert.strictEqual(got_LB.toString(), H1.toString('hex'), 'LAST_BLOCK_HASH')

        console.log('[smoke/loader] round-trip byte-exact OK')
    } finally {
        await db.close()
    }

    fs.rmSync(TMP, { recursive: true, force: true })
    console.log('[smoke/loader] all checks passed')
}

main().catch(err => {
    console.error('[smoke/loader] FAIL:', err)
    process.exit(1)
})
