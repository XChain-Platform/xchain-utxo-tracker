// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Litecoin's getrawtransaction answers in the MWEB serialization (litecoin
// src/primitives/transaction.h SerializeTransaction): version | 0x00 flags |
// vin | vout | witness when flags & 1 | mweb_tx when flags & 8 | nLockTime,
// where mweb_tx is an OptionalPtr (tag 0x00 for none, else a body). Each form
// must parse to Litecoin's own txid (no witness, no MWEB) with its real nLockTime,
// and keep its witness, where a P2WSH carrier keeps its payload; dropping only the
// marker and flag bytes reads the witness or MWEB tag as nLockTime. The vectors are real mainnet bytes
// (test/fixtures/wire_parse_vectors.json); the MWEB body is opaque to both
// services, so a fixed filler stands in for it.

const assert = require('assert')
const crypto = require('crypto')
const bitcoinjs = require('bitcoinjs-lib')
const XChainBlockDecoder = require('../../../src/chain/XChainBlockDecoder')
const VECTORS = require('../../fixtures/wire_parse_vectors.json')

const PEGIN = VECTORS.ltcPegin
const HOGEX = VECTORS.ltcHogEx3195200
const MWEB_BODY = Buffer.concat([Buffer.from([0x01]), crypto.createHash('sha512').update('mweb body').digest()])
const dsha = (b) => crypto.createHash('sha256').update(crypto.createHash('sha256').update(b).digest()).digest()
const txidOf = (b) => Buffer.from(dsha(b)).reverse().toString('hex')

// The pieces SerializeTransaction writes, cut from a real segwit tx.
function piecesOf(hex) {
    const full = Buffer.from(hex, 'hex')
    const tx = bitcoinjs.Transaction.fromBuffer(full)
    const bare = tx.clone()
    bare.ins.forEach(i => { i.witness = [] })
    const legacy = bare.toBuffer()
    const insOuts = legacy.subarray(4, legacy.length - 4)
    return {
        version: full.subarray(0, 4),
        insOuts,
        witness: full.subarray(6 + insOuts.length, full.length - 4),
        lockTime: full.subarray(full.length - 4),
        tx,
    }
}

// The getrawtransaction form of a tx that carries an MWEB part.
function mwebForm(hex, { withWitness }) {
    const p = piecesOf(hex)
    return Buffer.concat([p.version, Buffer.from([0x00, withWitness ? 0x09 : 0x08]), p.insOuts,
        withWitness ? p.witness : Buffer.alloc(0), MWEB_BODY, p.lockTime]).toString('hex')
}

// The real HogEx with its nLockTime replaced, and the txid Litecoin gives it
// (ComputeHash serializes without witness and without MWEB).
function hogExWithLockTime(lockTime) {
    const raw = Buffer.from(HOGEX.hex, 'hex')
    const lt = Buffer.alloc(4)
    lt.writeUInt32LE(lockTime)
    const hex = Buffer.concat([raw.subarray(0, raw.length - 4), lt])
    const plain = Buffer.concat([raw.subarray(0, 4), raw.subarray(6, raw.length - 5), lt])
    return { hex: hex.toString('hex'), txid: txidOf(plain) }
}

const ltc = () => new XChainBlockDecoder('litecoin-mainnet')

describe('Litecoin MWEB transaction serialization @regression', function () {
    describe('a standalone tx in its MWEB form [REGRESSION P1]', function () {
        it('a segwit peg-in with an MWEB part keeps its real txid, witness and locktime', function () {
            const p = piecesOf(PEGIN.hex)
            const tx = ltc().txFromHex(mwebForm(PEGIN.hex, { withWitness: true }))
            assert.strictEqual(tx.getId(), PEGIN.txid)
            assert.deepStrictEqual(tx.ins.map(i => i.witness), p.tx.ins.map(i => i.witness))
            assert.strictEqual(tx.locktime, p.tx.locktime)
            assert.strictEqual(tx.toHex(), PEGIN.hex)
        })

        it('the same tx without its witness (flag 0x08) keeps its real txid', function () {
            const tx = ltc().txFromHex(mwebForm(PEGIN.hex, { withWitness: false }))
            assert.strictEqual(tx.getId(), PEGIN.txid)
            assert.strictEqual(tx.ins[0].witness.length, 0)
        })

        it('the real HogEx (null MWEB tag, zero locktime) keeps its txid', function () {
            assert.strictEqual(ltc().txFromHex(HOGEX.hex).getId(), HOGEX.txid)
        })

        it('a HogEx with a nonzero locktime gets the txid Litecoin computes', function () {
            const h = hogExWithLockTime(3195200)
            const tx = ltc().txFromHex(h.hex)
            assert.strictEqual(tx.getId(), h.txid)
            assert.strictEqual(tx.locktime, 3195200)
        })

        it('a plain segwit tx parses exactly as before', function () {
            assert.strictEqual(ltc().txFromHex(PEGIN.hex).getId(), PEGIN.txid)
        })
    })
})

// A block's last tx is the HogEx; the MWEB extension block follows it.
function ltcBlock(lastTxHex, extension) {
    const coinbase = Buffer.from(VECTORS.doge4500000.txs[0], 'hex')
    const last = Buffer.from(lastTxHex, 'hex')
    const header = Buffer.alloc(80)
    header.writeInt32LE(0x20000000)
    // Merkle root over the coinbase and the last tx's Litecoin txid.
    const ids = [dsha(coinbase), dsha(Buffer.concat([last.subarray(0, 4), last.subarray(6, last.length - 5), last.subarray(last.length - 4)]))]
    dsha(Buffer.concat(ids)).copy(header, 36)
    return Buffer.concat([header, Buffer.from([0x02]), coinbase, last, extension]).toString('hex')
}

describe('Litecoin MWEB transaction serialization @regression', function () {
    describe('the HogEx inside a block [REGRESSION P1]', function () {
        it('the real HogEx keeps its txid with the extension block after it', function () {
            const block = ltc().blockFromHex(ltcBlock(HOGEX.hex, Buffer.from('0102030405', 'hex')))
            assert.strictEqual(block.transactions[1].getId(), HOGEX.txid)
        })

        it('a HogEx with a nonzero locktime gets the txid Litecoin computes', function () {
            const h = hogExWithLockTime(7)
            const block = ltc().blockFromHex(ltcBlock(h.hex, Buffer.alloc(0)))
            assert.strictEqual(block.transactions[1].getId(), h.txid)
        })

        it('refuses a non-null MWEB part inside a block, whose length nothing records', function () {
            const raw = Buffer.from(HOGEX.hex, 'hex')
            const tagged = Buffer.concat([raw.subarray(0, raw.length - 5), MWEB_BODY, raw.subarray(raw.length - 4)])
            assert.throws(() => ltc().blockFromHex(ltcBlock(tagged.toString('hex'), Buffer.alloc(0))), /MWEB/)
        })
    })
})
