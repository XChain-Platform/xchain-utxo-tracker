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

    describe('constructor defaults', function () {
        // auxPow now derives from the coin's wireFormat alone, so the
        // passed flag is inert. Bitcoin is false either way; dogecoin is true either way.
        it('sets auxPow from the coin wireFormat, not the passed flag', function () {
            const t1 = new XChainUtxoTracker('bitcoin-regtest', '127.0.0.1', '18443', 'u', 'p', 'db', true);
            expect(t1.auxPow).to.be.false;

            const t2 = new XChainUtxoTracker('bitcoin-regtest', '127.0.0.1', '18443', 'u', 'p', 'db', false);
            expect(t2.auxPow).to.be.false;

            const t3 = new XChainUtxoTracker('dogecoin-regtest', '127.0.0.1', '18443', 'u', 'p', 'db', false);
            expect(t3.auxPow).to.be.true;
        });

        it('initializes mempoolBusy to false', function () {
            expect(tracker.mempoolBusy).to.be.false;
        });

        it('initializes keepParsing to true', function () {
            expect(tracker.keepParsing).to.be.true;
        });

        it('initializes pendingKMCleanup to empty array', function () {
            expect(tracker.pendingKMCleanup).to.deep.equal([]);
        });
    });
});
