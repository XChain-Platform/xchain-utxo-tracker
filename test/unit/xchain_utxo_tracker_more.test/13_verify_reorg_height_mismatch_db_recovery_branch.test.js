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
const XChainUtxoTracker = require('../../../src/XChainUtxoTracker');
const LevelUpStore = require('../../../src/store/level_up_db');

let _dbCounter = 0;
function uniqueDbName(prefix) {
    return prefix + '-more-' + Date.now() + '-' + (++_dbCounter);
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

    describe('verifyReorg: height mismatch (db recovery branch)', function () {
        it('fixes mismatched lastBlockIndex and continues when lastBlock exists and heights are consistent', async function () {
            let callCount = 0;
            tracker.undoBlocks = 1000;
            sinon.stub(tracker, 'sleep').resolves();

            // First pass: lastBlockIndex(100) != lastBlock.h(99); triggers the fix branch.
            // Second pass: heights agree and node hash matches → thereAreDifferences = false.
            tracker.db = {
                getLastBlockHeight: sinon.stub()
                    .onFirstCall().resolves(100)
                    .onSecondCall().resolves(99),
                getLastBlockHash: sinon.stub()
                    .onFirstCall().resolves('hash100')
                    .onSecondCall().resolves('hash99'),
                getBlock: sinon.stub()
                    .onFirstCall().resolves({ h: 99 })   // mismatch: index=100, block.h=99
                    .onSecondCall().resolves({ h: 99 }),  // second pass: match
                getLastBlock: sinon.stub().resolves({ hash: 'hash99', height: 99 }),
                setLastBlockHash: sinon.stub().resolves(),
                setLastBlockHeight: sinon.stub().resolves(),
                // The pointer-repair branch now commits its writes in its own batch
                // so they reach disk before the loop re-reads the pointer.
                beginTransaction: sinon.stub().resolves(),
                endTransaction: sinon.stub().resolves()
            };
            tracker.connector = {
                getBlockHash: sinon.stub().resolves('hash99')
            };

            const result = await tracker.verifyReorg();
            expect(result).to.be.true;
            expect(tracker.db.setLastBlockHash.calledWith('hash99')).to.be.true;
        });

    });
});

describe('XChainUtxoTracker (more)', function () {
    this.timeout(15000);
    registerTrackerHooks();

    describe('verifyReorg: height mismatch (db recovery branch)', function () {
        it('throws when lastBlock exists but getLastBlock height is inconsistent', async function () {
            tracker.undoBlocks = 1000;
            sinon.stub(tracker, 'sleep').resolves();

            tracker.db = {
                getLastBlockHeight: sinon.stub().resolves(100),
                getLastBlockHash: sinon.stub().resolves('hash100'),
                // lastBlock.h=90 but index=100 → triggers inconsistency branch
                getBlock: sinon.stub().resolves({ h: 90 }),
                getLastBlock: sinon.stub().resolves({ hash: 'hashX', height: 95 }) // 95 != 90
            };

            let threw = false;
            try {
                await tracker.verifyReorg();
            } catch (err) {
                threw = true;
                expect(err.message).to.match(/inconsistent/i);
            }
            expect(threw).to.be.true;
        });

    });
});

describe('XChainUtxoTracker (more)', function () {
    this.timeout(15000);
    registerTrackerHooks();

    describe('verifyReorg: height mismatch (db recovery branch)', function () {
        it('handles null lastBlock (no block record) → fixes via getLastBlock', async function () {
            tracker.undoBlocks = 1000;
            sinon.stub(tracker, 'sleep').resolves();

            let pass = 0;
            tracker.db = {
                getLastBlockHeight: sinon.stub()
                    .onFirstCall().resolves(50)
                    .onSecondCall().resolves(50),
                getLastBlockHash: sinon.stub()
                    .onFirstCall().resolves('hashX')
                    .onSecondCall().resolves('hash50'),
                // First call: null (missing block) → triggers mismatch branch
                // Second call: real block
                getBlock: sinon.stub()
                    .onFirstCall().resolves(null)
                    .onSecondCall().resolves({ h: 50 }),
                getLastBlock: sinon.stub().resolves({ hash: 'hash50', height: 50 }),
                setLastBlockHash: sinon.stub().resolves(),
                setLastBlockHeight: sinon.stub().resolves(),
                // Pointer-repair branch commits its writes in its own batch now.
                beginTransaction: sinon.stub().resolves(),
                endTransaction: sinon.stub().resolves()
            };
            tracker.connector = {
                getBlockHash: sinon.stub().resolves('hash50')
            };

            const result = await tracker.verifyReorg();
            expect(result).to.be.true;
        });

    });
});

describe('XChainUtxoTracker (more)', function () {
    this.timeout(15000);
    registerTrackerHooks();

    describe('verifyReorg: height mismatch (db recovery branch)', function () {
        it('handles getBlockHash throwing (node error) → sleeps and retries', async function () {
            tracker.undoBlocks = 1000;

            let nodeCallCount = 0;
            tracker.db = {
                getLastBlockHeight: sinon.stub().resolves(10),
                getLastBlockHash: sinon.stub().resolves('hash10'),
                getBlock: sinon.stub().resolves({ h: 10 })
            };
            tracker.connector = {
                getBlockHash: sinon.stub()
                    .onFirstCall().rejects(new Error('connection refused'))
                    .onSecondCall().resolves('hash10')
            };
            const sleepStub = sinon.stub(tracker, 'sleep').resolves();

            const result = await tracker.verifyReorg();
            expect(result).to.be.true;
            expect(sleepStub.calledOnce).to.be.true;
        });

    });
});

describe('XChainUtxoTracker (more)', function () {
    this.timeout(15000);
    registerTrackerHooks();

    describe('verifyReorg: height mismatch (db recovery branch)', function () {
        it('throws when reorg depth exceeds undoBlocks', async function () {
            tracker.undoBlocks = 1;
            sinon.stub(tracker, 'sleep').resolves();
            tracker.removeFromLastBlocks = sinon.stub().resolves();

            const orphanHash = 'orphan1';
            tracker.db = {
                getLastBlockHeight: sinon.stub().resolves(10),
                getLastBlockHash: sinon.stub().resolves(orphanHash),
                getBlock: sinon.stub().resolves({ h: 10, ph: 'parent0' }),
                beginTransaction: sinon.stub().resolves(),
                endTransaction: sinon.stub().resolves(),
                removeOutputScriptsInBlock: sinon.stub().resolves(),
                processDeletedOutputs: sinon.stub().resolves(),
                removeCreatedOutputsInBlock: sinon.stub().resolves(),
                deleteBlock: sinon.stub().resolves(),
                setLastBlockHash: sinon.stub().resolves(),
                setLastBlockHeight: sinon.stub().resolves()
            };
            tracker.connector = {
                getBlockHash: sinon.stub().resolves('node_hash_10')
            };

            let threw = false;
            try {
                await tracker.verifyReorg();
            } catch (err) {
                threw = true;
                expect(err.message).to.match(/exceeds the recovery window/i);
            }
            expect(threw).to.be.true;
        });
    });
});
