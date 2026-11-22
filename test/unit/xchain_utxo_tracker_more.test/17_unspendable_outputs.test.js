'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// An unspendable output (OP_RETURN data, or a script over the consensus size cap)
// gets no UTXO records on the live confirmed path, the mempool path or bulk sync,
// while the outputs around it keep their real vout numbers.

const { expect } = require('chai');
const crypto = require('crypto');
const XChainUtxoTracker = require('../../../src/XChainUtxoTracker');
const LevelUpStore = require('../../../src/store/level_up_db');
const { isProvablyUnspendable } = require('../../../src/common/script.js');
const { processBlock } = require('../../../src/bulk_sync/process_block.js');

let counter = 0;
const randHash = () => crypto.randomBytes(32).toString('hex');
const sha256Hex = buf => crypto.createHash('sha256').update(buf).digest('hex');
const OP_RETURN_SCRIPT = Buffer.from('6a0568656c6c6f', 'hex');
const p2pkhScript = () => Buffer.concat([Buffer.from('76a914', 'hex'), crypto.randomBytes(20), Buffer.from('88ac', 'hex')]);

function threeOutputTx() {
    const txid = randHash();
    return {
        getId() { return txid; },
        getHash() { return Buffer.from(txid, 'hex').reverse(); },
        ins: [],
        outs: [
            { value: 1000n, script: p2pkhScript() },
            { value: 0n, script: OP_RETURN_SCRIPT },
            { value: 2000n, script: p2pkhScript() }
        ]
    };
}

async function openStore(tag) {
    const store = new LevelUpStore('unspendable-' + tag + '-' + Date.now() + '-' + (++counter), true);
    await store.createDatabase();
    return store;
}

async function expectOnlySpendableRecords(store, tx) {
    for (const vout of [0, 2]) {
        expect(await store.hasOutputForTx(tx.getId(), vout), 'H vout ' + vout).to.equal(true);
        expect(await store.getOutputsScriptPubKey(sha256Hex(tx.outs[vout].script)), 'O vout ' + vout).to.have.length(1);
    }
    expect(await store.hasOutputForTx(tx.getId(), 1)).to.equal(false);
    expect(await store.getOutputsScriptPubKey(sha256Hex(OP_RETURN_SCRIPT))).to.have.length(0);
}

let tracker, db, mempoolDb;

function registerStoreHooks() {
    beforeEach(async function () {
        tracker = new XChainUtxoTracker('bitcoin-regtest', '127.0.0.1', '18443', 'user', 'pass', 'test-db', false);
        db = await openStore('db');
        mempoolDb = await openStore('mempool');
        tracker.db = db;
        tracker.mempoolDb = mempoolDb;
    });

    afterEach(async function () {
        try { await db.close(); } catch (_) {}
        try { await mempoolDb.close(); } catch (_) {}
    });
}

function registerLiveCases() {
    it('matches the node rule for data, empty, ordinary and oversize scripts', function () {
        expect(isProvablyUnspendable(OP_RETURN_SCRIPT)).to.equal(true);
        expect(isProvablyUnspendable(Buffer.alloc(0))).to.equal(false);
        expect(isProvablyUnspendable(Buffer.from('76a914' + '00'.repeat(20) + '88ac', 'hex'))).to.equal(false);
        expect(isProvablyUnspendable(Buffer.alloc(10000, 0x51))).to.equal(false);
        expect(isProvablyUnspendable(Buffer.alloc(10001, 0x51))).to.equal(true);
    });

    it('the confirmed path stores the spendable outputs only and still counts every vout', async function () {
        const tx = threeOutputTx();
        const blockHash = randHash();
        await db.beginTransaction();
        const count = await tracker.parseTxOutputs(db, tx, blockHash, 10, true, false);
        await db.endTransaction(true);

        expect(count).to.equal(3);
        expect(await db.getTransactions(tx.getId())).to.have.length(1);
        await expectOnlySpendableRecords(db, tx);
        expect(await db.getOutputScriptBlock(sha256Hex(OP_RETURN_SCRIPT))).to.equal(null);
        expect(await db.getOutputScriptBlock(sha256Hex(tx.outs[2].script))).to.not.equal(null);
    });

    it('the mempool path stores the spendable outputs only and still counts every vout', async function () {
        const tx = threeOutputTx();
        await mempoolDb.beginTransaction();
        const info = await tracker.parseTransaction(mempoolDb, tx, null, -1, true);
        await mempoolDb.endTransaction(true);

        expect(info.outputsCount).to.equal(3);
        await expectOnlySpendableRecords(mempoolDb, tx);
    });
}

function registerBulkCase() {
    it('bulk sync emits the same outpoints the live path stores', function () {
        const tx = threeOutputTx();
        const appended = [];
        const writers = {
            outputs: { append: (txid, vout) => appended.push(txid.toString('hex') + ':' + vout) },
            spends: { append() {} },
            meta: { writeBlock() {} }
        };
        const block = { prevHash: Buffer.alloc(32), timestamp: 0, transactions: [tx] };
        const stats = processBlock(block, 10, Buffer.alloc(32, 1), writers);

        expect(appended).to.deep.equal([tx.getId() + ':0', tx.getId() + ':2']);
        expect(stats.outputs).to.equal(2);
    });
}

describe('Unspendable outputs get no UTXO records', function () {
    this.timeout(15000);
    registerStoreHooks();
    registerLiveCases();
    registerBulkCase();
});
