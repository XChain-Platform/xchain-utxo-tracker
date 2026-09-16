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

    describe('updateMempool', function () {
        beforeEach(function () {
            // Fast-path sleep for all updateMempool tests
            sinon.stub(tracker, 'sleep').resolves();
        });

        it('returns immediately and logs when mempoolBusy=true', async function () {
            tracker.mempoolBusy = true;
            const getRawStub = sinon.stub(tracker.connector, 'getRawMempool');

            await tracker.updateMempool();

            // mempoolBusy should stay true (set by caller, not by this path)
            expect(tracker.mempoolBusy).to.be.true;
            // Should NOT have called getRawMempool
            expect(getRawStub.called).to.be.false;
        });

        it('happy path: processes empty mempool (no new txs)', async function () {
            sinon.stub(tracker.connector, 'getRawMempool').resolves([]);
            sinon.stub(tracker.connector, 'getRawTransactions').resolves([]);

            await tracker.updateMempool();

            expect(tracker.mempoolBusy).to.be.false;
        });

        it('happy path: processes a mempool tx (mocked txFromHex)', async function () {
            const txid = randHash();
            sinon.stub(tracker.connector, 'getRawMempool').resolves([txid]);
            sinon.stub(tracker.connector, 'getRawTransactions').resolves(['fakehex']);

            const mockTx = makeTx({ ins: [makeCoinbaseInput()], outs: [makeOutput(1000)] });
            sinon.stub(tracker.xchainBlockDecoder, 'txFromHex').returns(mockTx);

            await tracker.updateMempool();

            expect(tracker.mempoolBusy).to.be.false;
        });

    });
});

describe('XChainUtxoTracker (more)', function () {
    this.timeout(15000);
    registerTrackerHooks();

    describe('updateMempool', function () {
        beforeEach(function () {
            // Fast-path sleep for all updateMempool tests
            sinon.stub(tracker, 'sleep').resolves();
        });

        it('getRawMempool throws → logs error and resets mempoolBusy', async function () {
            sinon.stub(tracker.connector, 'getRawMempool').rejects(new Error('node down'));

            await tracker.updateMempool();

            expect(tracker.mempoolBusy).to.be.false;
        });

        it('getRawTransactions fails MEMPOOL_MAX_TX_FETCH_RETRIES times → breaks and resets mempoolBusy', async function () {
            const RETRIES = 5; // MEMPOOL_MAX_TX_FETCH_RETRIES constant
            const txid = randHash();
            sinon.stub(tracker.connector, 'getRawMempool').resolves([txid]);
            sinon.stub(tracker.connector, 'getRawTransactions').rejects(new Error('rpc error'));

            await tracker.updateMempool();

            // After RETRIES failures it should break out (not hang forever).
            expect(tracker.mempoolBusy).to.be.false;
            // Sleep runs after each failure except the bail-out attempt: 5 failures,
            // breaks on attempt 5, so sleep is called on failures 1-4.
            // Sleep stub should have been called RETRIES times (one per failure before bail)
            // The implementation sleeps after each failure except the bail-out one
            // Actually: fails 5 times. On attempt 5 it breaks. Sleep called on failures 1-4.
            expect(tracker.sleep.callCount).to.be.at.least(RETRIES - 1);
        });

        it('null entry in getRawTransactions result is skipped', async function () {
            const txid = randHash();
            sinon.stub(tracker.connector, 'getRawMempool').resolves([txid]);
            // Return an array with a null entry
            sinon.stub(tracker.connector, 'getRawTransactions').resolves([null]);

            // parseTransaction should NOT be called for null entries
            const parseSpy = sinon.spy(tracker, 'parseTransaction');

            await tracker.updateMempool();

            expect(tracker.mempoolBusy).to.be.false;
            expect(parseSpy.called).to.be.false;
        });

    });
});

describe('XChainUtxoTracker (more)', function () {
    this.timeout(15000);
    registerTrackerHooks();

    describe('updateMempool', function () {
        beforeEach(function () {
            // Fast-path sleep for all updateMempool tests
            sinon.stub(tracker, 'sleep').resolves();
        });

        it('parse path throws → outer catch resets mempoolBusy', async function () {
            const txid = randHash();
            sinon.stub(tracker.connector, 'getRawMempool').resolves([txid]);
            sinon.stub(tracker.connector, 'getRawTransactions').resolves(['badhex']);
            // Force txFromHex to throw, triggering the outer catch block
            sinon.stub(tracker.xchainBlockDecoder, 'txFromHex').throws(new Error('decode error'));

            await tracker.updateMempool();

            expect(tracker.mempoolBusy).to.be.false;
        });

        it('calls deleteAndCompareTxsNotInList to remove stale mempool txs', async function () {
            sinon.stub(tracker.connector, 'getRawMempool').resolves([]);
            const delStub = sinon.stub(mempoolDb, 'deleteAndCompareTxsNotInList').resolves({
                transactionsDeleted: 0, inputsDeleted: 0, outputsDeleted: 0
            });

            await tracker.updateMempool();

            expect(delStub.calledOnce).to.be.true;
            expect(tracker.mempoolBusy).to.be.false;
        });

        it('resets mempoolBusy when deleteAndCompareTxsNotInList throws', async function () {
            sinon.stub(tracker.connector, 'getRawMempool').resolves([]);
            sinon.stub(mempoolDb, 'deleteAndCompareTxsNotInList').rejects(new Error('db fault'));

            await tracker.updateMempool();

            expect(tracker.mempoolBusy).to.be.false;
        });

    });
});

describe('XChainUtxoTracker (more)', function () {
    this.timeout(15000);
    registerTrackerHooks();

    describe('updateMempool', function () {
        beforeEach(function () {
            // Fast-path sleep for all updateMempool tests
            sinon.stub(tracker, 'sleep').resolves();
        });

        it('multi-batch: logs estimate and sleeps between batches when rawMempool > MEMPOOL_BATCH_SIZE', async function () {
            // MEMPOOL_BATCH_SIZE=1000; provide 1001 txids to trigger the multi-batch path
            // (lines 1224-1228 and 1284-1286).
            const BATCH_SIZE = 1000;
            const txids = Array.from({ length: BATCH_SIZE + 1 }, () => randHash());
            sinon.stub(tracker.connector, 'getRawMempool').resolves(txids.slice());
            // Both batches return empty so parseTransaction is never called
            sinon.stub(tracker.connector, 'getRawTransactions').resolves([]);
            sinon.stub(mempoolDb, 'deleteAndCompareTxsNotInList').resolves({
                transactionsDeleted: 0, inputsDeleted: 0, outputsDeleted: 0
            });

            await tracker.updateMempool();

            expect(tracker.mempoolBusy).to.be.false;
            // The inter-batch sleep should have been called at least once (between batch 1 and 2)
            expect(tracker.sleep.callCount).to.be.at.least(1);
        });
    });
});
