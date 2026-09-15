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

    describe('loadLastBlocksSortedByHeight', function () {
        it('returns hashes sorted by ascending height', async function () {
            const h100 = randHash();
            const h200 = randHash();
            const h50 = randHash();

            // Populate the db with blocks
            await db.beginTransaction();
            await db.insertBlock({ hash: h100, height: 100, timestamp: 0, previousHash: randHash() });
            await db.insertBlock({ hash: h200, height: 200, timestamp: 0, previousHash: randHash() });
            await db.insertBlock({ hash: h50,  height: 50,  timestamp: 0, previousHash: randHash() });
            // Insert them as "last stored blocks"
            db.addLastStoredBlock(h100);
            db.addLastStoredBlock(h200);
            db.addLastStoredBlock(h50);
            await db.endTransaction();

            const sorted = await tracker.loadLastBlocksSortedByHeight();
            const idx50  = sorted.indexOf(h50);
            const idx100 = sorted.indexOf(h100);
            const idx200 = sorted.indexOf(h200);

            expect(idx50).to.be.lessThan(idx100);
            expect(idx100).to.be.lessThan(idx200);
        });

        it('returns empty array when no stored blocks', async function () {
            const sorted = await tracker.loadLastBlocksSortedByHeight();
            expect(sorted).to.deep.equal([]);
        });

        it('handles a block missing from B-records (height=-1)', async function () {
            const h1 = randHash();
            const h2 = randHash();

            // Only insert a B-record for h2
            await db.beginTransaction();
            await db.insertBlock({ hash: h2, height: 99, timestamp: 0, previousHash: randHash() });
            db.addLastStoredBlock(h1); // no B-record → height=-1
            db.addLastStoredBlock(h2);
            await db.endTransaction();

            const sorted = await tracker.loadLastBlocksSortedByHeight();
            // h1 (height=-1) must come before h2 (height=99)
            expect(sorted.indexOf(h1)).to.be.lessThan(sorted.indexOf(h2));
        });
    });
});
