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

    describe('stopParsing (mempoolInterval cleanup)', function () {
        it('clears mempoolInterval on a successful stop', async function () {
            const fakeInterval = setInterval(() => {}, 99999);
            tracker.mempoolInterval = fakeInterval;
            // parsingStopped already true: the stop succeeds immediately.
            tracker.parsingStopped = true;
            sinon.stub(tracker, 'sleep').resolves();

            const result = await tracker.stopParsing();
            expect(result).to.be.true;
            // A successful stop tears the poller down and leaves it null.
            expect(tracker.mempoolInterval).to.be.null;
            clearInterval(fakeInterval);
        });

        it('re-arms the mempool poller and stays running on a failed (timed-out) stop', async function () {
            const fakeInterval = setInterval(() => {}, 99999);
            tracker.mempoolInterval = fakeInterval;
            tracker.parsingStopped = false;
            sinon.stub(tracker, 'sleep').resolves();

            let rejected = false;
            try {
                await tracker.stopParsing();
            } catch (_) {
                rejected = true;
            }

            // A failed stop must NOT leave the tracker half-dead: keepParsing is
            // restored and the mempool poller is re-armed (non-null) so the still-
            // running loop keeps serving queries instead of closing its DB.
            expect(rejected).to.be.true;
            expect(tracker.keepParsing).to.be.true;
            expect(tracker.mempoolInterval).to.not.be.null;
            clearInterval(fakeInterval);
            if (tracker.mempoolInterval) { clearInterval(tracker.mempoolInterval); tracker.mempoolInterval = null; }
        });
    });
});
