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

// Ad-hoc smoke test for process-block.js. Uses a hand-built mock of the
// decoded Bitcoin mainnet genesis block (to avoid requiring bitcoinjs-lib
// locally — real-decoder integration is exercised on dankesttest).
//
// Genesis facts (Bitcoin mainnet, block 0):
//   blockHash      (display): 000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f
//   merkleRoot     (internal LE): 3ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a
//   txid           (display) = reverse(merkleRoot) since there is only 1 tx:
//                  4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b
//   timestamp      : 1231006505
//   coinbase output: 50 BTC (5000000000 sat) to a 67-byte P2PK script.

const fs     = require('fs')
const os     = require('os')
const path   = require('path')
const assert = require('assert')
const crypto = require('crypto')

const { processBlock } = require('./process-block.js')
const {
    OutputsWriter, SpendsWriter, MetaWriter,
    HEADER_SIZE, OUTPUTS_RECORD_SIZE,
} = require('./writers.js')

const GENESIS_BLOCK_HASH_HEX = '000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f'
const GENESIS_TXID_HEX       = '4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b'
const GENESIS_MERKLE_LE_HEX  = '3ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a'
const GENESIS_TIMESTAMP      = 1231006505
const GENESIS_COINBASE_SCRIPT_HEX =
    '4104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb64' +
    '9f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac'
const GENESIS_COINBASE_VALUE = 5000000000

const txInternalHash = Buffer.from(GENESIS_MERKLE_LE_HEX, 'hex') // getHash() returns LE
const coinbaseScript = Buffer.from(GENESIS_COINBASE_SCRIPT_HEX, 'hex')

const mockBlock = {
    prevHash: Buffer.alloc(32, 0x00), // genesis
    timestamp: GENESIS_TIMESTAMP,
    transactions: [
        {
            getHash() { return txInternalHash },
            outs: [
                { script: coinbaseScript, value: GENESIS_COINBASE_VALUE },
            ],
            ins: [
                { hash: Buffer.alloc(32, 0x00), index: 0xFFFFFFFF }, // coinbase
            ],
        },
    ],
}

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-bulk-sync-pb-'))
console.log('[smoke/process-block] tmp dir:', TMP_DIR)

const outPath  = path.join(TMP_DIR, 'outputs-w00-h00000000-h00000000.dat')
const spdPath  = path.join(TMP_DIR, 'spends-w00-h00000000-h00000000.dat')
const metaPath = path.join(TMP_DIR, 'meta-w00-h00000000-h00000000.dat')

const outputs = new OutputsWriter(outPath,  'bitcoin', 'mainnet', 0, 0)
const spends  = new SpendsWriter(spdPath,   'bitcoin', 'mainnet', 0, 0)
const meta    = new MetaWriter(metaPath,    'bitcoin', 'mainnet', 0, 0)

const blockHash = Buffer.from(GENESIS_BLOCK_HASH_HEX, 'hex')
const stats     = processBlock(mockBlock, 0, blockHash, { outputs, spends, meta })
console.log('[smoke/process-block] stats:', stats)

assert.deepStrictEqual(stats, { txs: 1, outputs: 1, spends: 0 })

outputs.close()
spends.close()
meta.close()

// ---- outputs-*.dat ----
{
    const buf = fs.readFileSync(outPath)
    assert.strictEqual(buf.length, HEADER_SIZE + OUTPUTS_RECORD_SIZE)
    assert.strictEqual(Number(buf.readBigUInt64LE(20)), 1)

    const r = buf.slice(HEADER_SIZE)
    assert.strictEqual(
        r.slice(0, 8).toString('hex'),
        GENESIS_TXID_HEX.substring(0, 16),
        'outputs txHash8 = first 8 bytes of display txid',
    )
    assert.strictEqual(r.readUInt32BE(8), 0,                       'vout')
    assert.strictEqual(r.readBigUInt64BE(12), BigInt(GENESIS_COINBASE_VALUE), 'value')
    assert.strictEqual(r.readInt32BE(20), 0,                       'height')
    assert.strictEqual(
        r.slice(24, 56).toString('hex'),
        GENESIS_TXID_HEX,
        'outputs fullTxHash',
    )
    const expectedScriptHash = crypto.createHash('sha256').update(coinbaseScript).digest()
    assert.strictEqual(
        r.slice(56, 88).toString('hex'),
        expectedScriptHash.toString('hex'),
        'outputs scriptPubKey = sha256(script)',
    )
    assert.strictEqual(
        r.slice(88, 120).toString('hex'),
        GENESIS_BLOCK_HASH_HEX,
        'outputs blockHash',
    )
    console.log('[smoke/process-block] outputs-*.dat OK')
}

// ---- spends-*.dat: coinbase skipped, file is header-only ----
{
    const buf = fs.readFileSync(spdPath)
    assert.strictEqual(buf.length, HEADER_SIZE)
    assert.strictEqual(Number(buf.readBigUInt64LE(20)), 0)
    console.log('[smoke/process-block] spends-*.dat OK')
}

// ---- meta-*.dat ----
{
    const buf = fs.readFileSync(metaPath)
    assert.strictEqual(buf.length, HEADER_SIZE + 76 + 8)
    assert.strictEqual(Number(buf.readBigUInt64LE(20)), 1)

    let off = HEADER_SIZE
    assert.strictEqual(buf.readUInt32BE(off + 0), 0,                 'height')
    assert.strictEqual(buf.readUInt32BE(off + 4), GENESIS_TIMESTAMP, 'timestamp')
    assert.strictEqual(
        buf.slice(off + 8, off + 40).toString('hex'),
        GENESIS_BLOCK_HASH_HEX,
        'meta blockHash',
    )
    assert.strictEqual(
        buf.slice(off + 40, off + 72).toString('hex'),
        '0'.repeat(64),
        'meta previousHash = zeros (genesis)',
    )
    assert.strictEqual(buf.readUInt32BE(off + 72), 1, 'tx_count')
    assert.strictEqual(
        buf.slice(off + 76, off + 84).toString('hex'),
        GENESIS_TXID_HEX.substring(0, 16),
        'meta txHash8',
    )
    console.log('[smoke/process-block] meta-*.dat OK')
}

// ---- non-coinbase input path: synthetic block with 1 spend ----
{
    const prevInternalLE = Buffer.from(
        '11223344556677889900aabbccddeeff' +
        '00000000000000000000000000000000',
        'hex',
    )
    // First 8 bytes of the display-order hash = last 8 bytes of LE, reversed.
    const expectedPrev8Hex = '0000000000000000' // because the high half of prevInternalLE is zeros

    const synthTxInternal = Buffer.alloc(32, 0x77)
    const synthScript     = Buffer.from('76a914' + '00'.repeat(20) + '88ac', 'hex')

    const synthBlockHash    = Buffer.alloc(32, 0xbb)
    const synthPrevBlockLE  = Buffer.alloc(32, 0xaa)

    const synthBlock = {
        prevHash: synthPrevBlockLE,
        timestamp: 1_800_000_000,
        transactions: [
            {
                getHash() { return synthTxInternal },
                outs: [
                    { script: synthScript, value: 100000 },
                ],
                ins: [
                    { hash: prevInternalLE, index: 3 },
                ],
            },
        ],
    }

    const out2  = path.join(TMP_DIR, 'outputs-w01-h00000001-h00000001.dat')
    const spd2  = path.join(TMP_DIR, 'spends-w01-h00000001-h00000001.dat')
    const meta2 = path.join(TMP_DIR, 'meta-w01-h00000001-h00000001.dat')
    const o2 = new OutputsWriter(out2,  'bitcoin', 'regtest', 1, 1)
    const s2 = new SpendsWriter(spd2,   'bitcoin', 'regtest', 1, 1)
    const m2 = new MetaWriter(meta2,    'bitcoin', 'regtest', 1, 1)

    const stats2 = processBlock(synthBlock, 1, synthBlockHash, { outputs: o2, spends: s2, meta: m2 })
    assert.deepStrictEqual(stats2, { txs: 1, outputs: 1, spends: 1 })

    o2.close()
    s2.close()
    m2.close()

    const spdBuf = fs.readFileSync(spd2)
    assert.strictEqual(spdBuf.length, HEADER_SIZE + 20)
    assert.strictEqual(Number(spdBuf.readBigUInt64LE(20)), 1)
    const sr = spdBuf.slice(HEADER_SIZE)
    assert.strictEqual(sr.slice(0, 8).toString('hex'), expectedPrev8Hex, 'spends prevTxHash8 reversed correctly')
    assert.strictEqual(sr.readUInt32BE(8), 3, 'spends prevVout')
    // spenderTxHash8 = first 8 bytes of reverse(synthTxInternal) = still all 0x77
    assert.strictEqual(sr.slice(12, 20).toString('hex'), '7777777777777777', 'spends spenderTxHash8')

    // meta previousHash should equal reverse(synthPrevBlockLE) = still all 0xaa
    const metaBuf = fs.readFileSync(meta2)
    assert.strictEqual(
        metaBuf.slice(HEADER_SIZE + 40, HEADER_SIZE + 72).toString('hex'),
        'aa'.repeat(32),
        'meta previousHash reversed',
    )

    console.log('[smoke/process-block] non-coinbase + reverse path OK')
}

fs.rmSync(TMP_DIR, { recursive: true, force: true })
console.log('[smoke/process-block] all checks passed')
