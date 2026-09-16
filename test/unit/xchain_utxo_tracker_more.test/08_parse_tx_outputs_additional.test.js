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

    describe('parseTxOutputs (additional)', function () {
        it('uses tx.id when present', async function () {
            const customId = randHash();
            const tx = {
                id: customId,
                ins: [],
                outs: [makeOutput(1000)]
            };

            await db.beginTransaction();
            const count = await tracker.parseTxOutputs(db, tx, randHash(), 10, false, false);
            await db.endTransaction(true);

            expect(count).to.equal(1);
            const txs = await db.getTransactions(customId.substring(0, 16));
            expect(txs).to.have.length(1);
        });

        it('inserts output hints when addHints=true (even removeSpent=false)', async function () {
            const tx = makeTx({ outs: [makeOutput(2000)] });
            const blockHash = randHash();

            await db.beginTransaction();
            await tracker.parseTxOutputs(db, tx, blockHash, 10, true, false);
            await db.endTransaction(true);

            const scriptHash = crypto.createHash('sha256').update(tx.outs[0].script).digest('hex');
            const outputs = await db.getOutputsScriptPubKey(scriptHash);
            expect(outputs).to.have.length(1);
        });

        it('returns 0 for a tx with no outputs', async function () {
            const tx = makeTx({ outs: [] });

            await db.beginTransaction();
            const count = await tracker.parseTxOutputs(db, tx, randHash(), 10, false, false);
            await db.endTransaction(true);

            expect(count).to.equal(0);
        });
    });
});
