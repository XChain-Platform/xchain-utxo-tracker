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

const { expect } = require('chai');
const sinon = require('sinon');
const crypto = require('crypto');
const XChainUtxoTracker = require('../../../src/XChainUtxoTracker');
const LevelUpStore = require('../../../src/store/level_up_db');

let _dbCounter = 0;
function uniqueDbName(prefix) {
    return prefix + '-more-' + Date.now() + '-' + (++_dbCounter);
}

function randHash() { return crypto.randomBytes(32).toString('hex'); }

function makeTx(opts = {}) {
    const txid = opts.txid || randHash();
    return {
        getId() { return txid; },
        ins: opts.ins || [],
        outs: opts.outs || []
    };
}

function makeOutput(valueSats = 100000000) {
    return {
        value: BigInt(valueSats),
        script: crypto.randomBytes(25)
    };
}

function makeCoinbaseInput() {
    return {
        hash: Buffer.alloc(32, 0),
        index: 4294967295, // 0xFFFFFFFF coinbase sentinel
        script: Buffer.alloc(4)
    };
}

function makeSpendInput(prevTxIdHex, prevVout = 0) {
    const hashBuf = Buffer.from(prevTxIdHex, 'hex').reverse();
    return {
        hash: hashBuf,
        index: prevVout,
        script: Buffer.alloc(0)
    };
}

async function makeTracker() {
    const tracker = new XChainUtxoTracker(
        'bitcoin-regtest', '127.0.0.1', '18443', 'user', 'pass', 'test-db', false
    );
    const db = new LevelUpStore(uniqueDbName('tracker'), true);
    const mempoolDb = new LevelUpStore(uniqueDbName('mempool'), true);
    await db.createDatabase();
    await mempoolDb.createDatabase();
    tracker.db = db;
    tracker.mempoolDb = mempoolDb;
    tracker.blockchainInfoLastBlock = 1000;
    return { tracker, db, mempoolDb };
}

let tracker, db, mempoolDb;

function registerTrackerHooks() {
    beforeEach(async function () {
        ({ tracker, db, mempoolDb } = await makeTracker());
    });

    afterEach(async function () {
        sinon.restore();
        try { await db.close(); } catch (_) {}
        try { await mempoolDb.close(); } catch (_) {}
    });
}

describe('XChainUtxoTracker (more)', function () {
    this.timeout(15000);
    registerTrackerHooks();

    describe('parseTransaction', function () {
        it('inserts transaction record when removeSpent=false', async function () {
            const tx = makeTx({ ins: [makeCoinbaseInput()], outs: [makeOutput(1000)] });
            const txid = tx.getId();
            const blockHash = randHash();

            await db.beginTransaction();
            const info = await tracker.parseTransaction(db, tx, blockHash, 10, false, false);
            await db.endTransaction(true);

            expect(info.outputsCount).to.equal(1);
            const txs = await db.getTransactions(txid.substring(0, 16));
            expect(txs).to.have.length(1);
        });

        it('does NOT insert transaction record when removeSpent=true', async function () {
            const tx = makeTx({ ins: [makeCoinbaseInput()], outs: [makeOutput(1000)] });
            const txid = tx.getId();
            const blockHash = randHash();

            await db.beginTransaction();
            const info = await tracker.parseTransaction(db, tx, blockHash, 10, false, true);
            await db.endTransaction(true);

            expect(info.outputsCount).to.equal(1);
            const txs = await db.getTransactions(txid.substring(0, 16));
            expect(txs).to.be.empty;
        });

        it('skips coinbase input and counts 0 inputs', async function () {
            const tx = makeTx({ ins: [makeCoinbaseInput()], outs: [makeOutput(5000)] });

            await db.beginTransaction();
            const info = await tracker.parseTransaction(db, tx, randHash(), 5, false, false);
            await db.endTransaction(true);

            expect(info.inputsCount).to.equal(0);
        });

        it('counts non-coinbase inputs', async function () {
            const prevId = randHash();
            const tx = makeTx({ ins: [makeSpendInput(prevId, 0)], outs: [makeOutput(999)] });

            await db.beginTransaction();
            const info = await tracker.parseTransaction(db, tx, randHash(), 5, false, false);
            await db.endTransaction(true);

            expect(info.inputsCount).to.equal(1);
        });

    });
});

describe('XChainUtxoTracker (more)', function () {
    this.timeout(15000);
    registerTrackerHooks();

    describe('parseTransaction', function () {
        it('uses transaction.id when present (AuxPoW renamed id)', async function () {
            const customId = randHash();
            const tx = {
                id: customId,
                ins: [makeCoinbaseInput()],
                outs: [makeOutput(1000)]
            };

            await db.beginTransaction();
            const info = await tracker.parseTransaction(db, tx, randHash(), 5, false, false);
            await db.endTransaction(true);

            const txs = await db.getTransactions(customId.substring(0, 16));
            expect(txs).to.have.length(1);
        });

        it('inserts hints when addHints=true', async function () {
            const prevId = randHash();
            const tx = makeTx({
                ins: [makeSpendInput(prevId, 0)],
                outs: [makeOutput(500)]
            });

            await db.beginTransaction();
            const info = await tracker.parseTransaction(db, tx, randHash(), 7, true, false);
            await db.endTransaction(true);

            expect(info.inputsCount).to.equal(1);
            expect(info.outputsCount).to.equal(1);
        });

    });
});

describe('XChainUtxoTracker (more)', function () {
    this.timeout(15000);
    registerTrackerHooks();

    describe('parseTransaction', function () {
        it('calls removeOutputWithInput when removeSpent=true (non-coinbase)', async function () {
            const prevId = randHash();
            const tx = makeTx({
                ins: [makeSpendInput(prevId, 0)],
                outs: [makeOutput(500)]
            });

            const removeStub = sinon.stub(db, 'removeOutputWithInput').resolves();

            await db.beginTransaction();
            await tracker.parseTransaction(db, tx, randHash(), 7, false, true);
            await db.endTransaction(true);

            expect(removeStub.calledOnce).to.be.true;
        });

        it('skips non-standard inputs (standard_input=false)', async function () {
            const tx = makeTx({
                ins: [{ hash: Buffer.alloc(32), index: 0, script: Buffer.alloc(0), standard_input: false }],
                outs: [makeOutput(100)]
            });

            await db.beginTransaction();
            const info = await tracker.parseTransaction(db, tx, randHash(), 1, false, false);
            await db.endTransaction(true);

            expect(info.inputsCount).to.equal(0);
        });
    });
});
