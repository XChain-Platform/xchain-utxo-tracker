// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Pending outputs are keyed on the txid the node listed in getrawmempool, and the
// parsed tx must hash to that same txid before anything is staged. A Litecoin tx
// in its MWEB serialization (real peg-in bytes, opaque MWEB filler) must stage its
// outputs under its real txid. A tx whose parse hashes to anything else fails the
// pass, which withdraws mempool readiness, as any other unparseable tx does. An
// MWEB-only tx (no transparent inputs or outputs) has nothing to stage and is skipped.

const assert = require('assert')
const crypto = require('crypto')
const bitcoinjs = require('bitcoinjs-lib')
const XChainUtxoTracker = require('../../../src/XChainUtxoTracker')
const LevelUpStore = require('../../../src/store/level_up_db')
const VECTORS = require('../../fixtures/wire_parse_vectors.json')

const PEGIN = VECTORS.ltcPegin
const MWEB_BODY = Buffer.concat([Buffer.from([0x01]), crypto.createHash('sha512').update('mweb body').digest()])

function mwebForm(hex) {
    const full = Buffer.from(hex, 'hex')
    const bare = bitcoinjs.Transaction.fromBuffer(full)
    bare.ins.forEach(i => { i.witness = [] })
    const legacy = bare.toBuffer()
    const insOuts = legacy.subarray(4, legacy.length - 4)
    return Buffer.concat([full.subarray(0, 4), Buffer.from([0x00, 0x09]), insOuts,
        full.subarray(6 + insOuts.length, full.length - 4), MWEB_BODY, full.subarray(full.length - 4)]).toString('hex')
}

// version 2 | 0x00 0x08 | no inputs | no outputs | MWEB body | nLockTime 0
const MWEB_ONLY_HEX = '02000000' + '0008' + '00' + '00' + MWEB_BODY.toString('hex') + '00000000'

let counter = 0
async function trackerServing(listing) {
    const tracker = new XChainUtxoTracker('litecoin-regtest', '127.0.0.1', '19443', 'u', 'p', 'wire-db', false)
    tracker.mempoolDb = new LevelUpStore('wire-parse-mempool-' + Date.now() + '-' + (++counter), true)
    await tracker.mempoolDb.createDatabase()
    tracker.sleep = async () => {}
    tracker.connector.getRawMempool = async () => listing.map(x => x.txid)
    // No node here: the prune's tip read fails closed instead of opening a socket.
    tracker.connector.getBlockchainInfo = async () => { throw new Error('no node in unit tests') }
    tracker.connector.getRawTransactions = async (ids) => ids.map(id => listing.find(x => x.txid === id).hex)
    return tracker
}

async function pendingTxids(tracker) {
    const script = bitcoinjs.Transaction.fromHex(PEGIN.hex).outs[0].script
    const hash = crypto.createHash('sha256').update(script).digest('hex')
    const outs = (await tracker.mempoolDb.getOutputsScriptPubKey(hash, { maxOutputs: 10 })) || []
    return outs.map(o => o.fullTxid)
}

describe('tracker mempool outputs keyed on the node txid @regression', function () {
    describe('an MWEB-form Litecoin tx [REGRESSION P1]', function () {
        it('stages its outputs under the node txid', async function () {
            const tracker = await trackerServing([{ txid: PEGIN.txid, hex: mwebForm(PEGIN.hex) }])
            try {
                await tracker.updateMempool()
                assert.deepStrictEqual(await pendingTxids(tracker), [PEGIN.txid])
                assert.strictEqual(tracker.mempoolReconverged, true)
            } finally { await tracker.mempoolDb.close() }
        })

        it('withdraws readiness and stages nothing when the parse does not hash to the node txid', async function () {
            const tracker = await trackerServing([{ txid: 'ab'.repeat(32), hex: PEGIN.hex }])
            try {
                await tracker.updateMempool()
                assert.deepStrictEqual(await pendingTxids(tracker), [])
                assert.strictEqual(tracker.mempoolReconverged, false)
            } finally { await tracker.mempoolDb.close() }
        })

        it('skips an MWEB-only tx and still reconverges', async function () {
            const tracker = await trackerServing([{ txid: 'cd'.repeat(32), hex: MWEB_ONLY_HEX },
                { txid: PEGIN.txid, hex: mwebForm(PEGIN.hex) }])
            try {
                await tracker.updateMempool()
                assert.deepStrictEqual(await pendingTxids(tracker), [PEGIN.txid])
                assert.strictEqual(tracker.mempoolReconverged, true)
            } finally { await tracker.mempoolDb.close() }
        })
    })
})
