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

function randHash8() { return crypto.randomBytes(8).toString('hex'); }

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

    describe('getBalanceInfo (mempool-spent mempool output)', function () {
        it('excludes mempool output spent by another mempool input', async function () {
            const bitcoin = require('bitcoinjs-lib');
            const { createHash } = require('crypto');
            const address = 'n1wgm6kkzMcNfAtJmes8YhpvtDzdNhDY5a';
            const script = bitcoin.address.toOutputScript(address, tracker.network);
            const scriptHash = createHash('sha256').update(script).digest('hex');

            const fullTxHash = randHash();
            const txHash8 = fullTxHash.substring(0, 16);

            // Insert mempool output in one transaction
            await mempoolDb.beginTransaction();
            await mempoolDb.insertOutput({
                scriptPubKey: scriptHash,
                txHash: txHash8,
                outputIndex: 0,
                value: BigInt('75000000'),
                height: -1,
                fullTxHash
            });
            // Also insert mempool input spending it in the same transaction
            await mempoolDb.insertInput({
                prevTxHash: fullTxHash,
                prevOutputIndex: 0,
                txHash: randHash8()
            });
            await mempoolDb.endTransaction(true);

            const info = await tracker.getBalanceInfo(address);
            // The mempool output is being spent → should NOT count as pending income
            expect(info.balances.pending).to.equal('0.00000000');
            expect(info.utxos.pending).to.equal(0);
        });
    });
});
