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

    // ── addToLastBlocks: deletedTransactionArray branch (lines 159-161) ──
    describe('addToLastBlocks deletedTransactionArray cleanup', function () {
        it('removes block from deletedTransactionArray when it ages out', async function () {
            // Fill lastBlocks to capacity by setting undoBlocks=2 then adding 3 blocks.
            // When the 3rd is added, the oldest shifts out and should be removed from
            // deletedTransactionArray if present (lines 159-161).
            tracker.undoBlocks = 2;

            const h1 = randHash();
            const h2 = randHash();
            const h3 = randHash();

            // Begin transaction FIRST (sets deletedTransactionArray to a new Map),
            // then inject h1 into it to simulate a same-block spend record.
            await db.beginTransaction();
            db.deletedTransactionArray.set(h1, new Map());

            await tracker.addToLastBlocks(h1);
            await tracker.addToLastBlocks(h2);
            // Adding h3 causes h1 to shift out; the code should delete h1 from the Map
            await tracker.addToLastBlocks(h3);

            // Check before endTransaction nulls the map
            expect(db.deletedTransactionArray.has(h1)).to.be.false;
            // h1 should be in pendingKMCleanup
            expect(tracker.pendingKMCleanup).to.include(h1);
            // lastBlocks should only have h2 and h3
            expect(tracker.lastBlocks).to.deep.equal([h2, h3]);

            await db.endTransaction(true);
        });
    });
});
