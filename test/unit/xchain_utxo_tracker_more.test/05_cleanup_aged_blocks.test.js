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

    describe('cleanupAgedBlocks', function () {
        it('is a no-op when pendingKMCleanup is empty', async function () {
            tracker.pendingKMCleanup = [];
            // Should not throw or touch db
            const beginSpy = sinon.spy(db, 'beginTransaction');
            await tracker.cleanupAgedBlocks();
            expect(beginSpy.called).to.be.false;
        });

        it('clears pendingKMCleanup and processes each block', async function () {
            const h1 = randHash();
            const h2 = randHash();
            tracker.pendingKMCleanup = [h1, h2];

            const processStub = sinon.stub(db, 'processDeletedOutputs').resolves();
            const removeStub = sinon.stub(db, 'removeLastStoredBlock').resolves();

            await tracker.cleanupAgedBlocks();

            expect(processStub.callCount).to.equal(2);
            expect(removeStub.callCount).to.equal(2);
            expect(tracker.pendingKMCleanup).to.deep.equal([]);
        });
    });
});
