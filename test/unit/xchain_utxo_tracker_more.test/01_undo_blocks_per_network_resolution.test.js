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

    // ── coinFromNetwork / resolveUndoBlocks (via constructor side-effects) ──
    describe('undoBlocks per-network resolution', function () {
        it('bitcoin-mainnet resolves to BTC default', function () {
            const t = new XChainUtxoTracker('bitcoin-mainnet', '127.0.0.1', '8332', 'u', 'p', 'db', false);
            expect(t.undoBlocks).to.equal(12);
        });

        it('litecoin-mainnet resolves to LTC default', function () {
            const t = new XChainUtxoTracker('litecoin-mainnet', '127.0.0.1', '9332', 'u', 'p', 'db', false);
            // Raised from 48 on 2026-09-01 after a litecoin testnet fork outran
            // that window; see DEFAULT_UNDO_BLOCKS in src/undo-blocks.js.
            expect(t.undoBlocks).to.equal(120);
        });

        it('dogecoin-mainnet resolves to DOGE default', function () {
            const t = new XChainUtxoTracker('dogecoin-mainnet', '127.0.0.1', '22555', 'u', 'p', 'db', false);
            expect(t.undoBlocks).to.equal(120);
        });

        it('unknown network fails loud at construction instead of decoding under a default network', function () {
            // getBitcoinJsNetwork itself now refuses an unresolvable network name
            // (item 5879), so construction stops on the very first line rather than
            // relying on the guard below it; either way an unknown network never
            // gets far enough to decode addresses under bitcoinjs's BTC-mainnet
            // default. The regex spans both messages on purpose.
            // getBitcoinJsNetwork returns undefined for an unresolvable network name;
            // the constructor now asserts on that before it would otherwise reach
            // resolveUndoBlocks' own fallback, so an unknown network never gets far
            // enough to silently decode addresses under bitcoinjs's BTC-mainnet default.
            expect(() => new XChainUtxoTracker('unknown-mainnet', '127.0.0.1', '1234', 'u', 'p', 'db', false))
                .to.throw(/[Uu]nknown network/);
        });
    });
});
