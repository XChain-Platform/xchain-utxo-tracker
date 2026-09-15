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

    describe('getAddressType', function () {
        it('detects P2SH address', function () {
            // P2SH on regtest starts with '2'
            const type = tracker.getAddressType('2MzQwSSnBHWHqSAqtTVQ6v47XtaisrJa1Vc', tracker.network);
            expect(type).to.equal('p2sh');
        });

        it('detects P2TR (taproot) address (regression: needs initEccLib)', function () {
            // src/XChainUtxoTracker.js registers tiny-secp256k1 via bitcoin.initEccLib
            // at module load, so payments.p2tr() works and taproot addresses are
            // classified correctly instead of silently falling through to 'unknown'.
            const bitcoin = require('bitcoinjs-lib');
            const type = tracker.getAddressType(
                'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0',
                bitcoin.networks.bitcoin
            );
            expect(type).to.equal('p2tr');
        });

        it('returns unknown for garbage', function () {
            const type = tracker.getAddressType('zzzznotanaddress', tracker.network);
            expect(type).to.equal('unknown');
        });
    });
});
