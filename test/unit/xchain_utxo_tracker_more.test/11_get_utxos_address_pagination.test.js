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

    describe('getUtxosAddress pagination', function () {
        it('limits results and sets nextCursor', async function () {
            const bitcoin = require('bitcoinjs-lib');
            const { createHash } = require('crypto');
            const address = 'n1wgm6kkzMcNfAtJmes8YhpvtDzdNhDY5a';
            const script = bitcoin.address.toOutputScript(address, tracker.network);
            const scriptHash = createHash('sha256').update(script).digest('hex');

            // Insert 3 confirmed outputs in a single transaction
            await db.beginTransaction();
            for (let i = 0; i < 3; i++) {
                const fh = randHash();
                await db.insertOutput({
                    scriptPubKey: scriptHash,
                    txHash: fh.substring(0, 16),
                    outputIndex: i,
                    value: BigInt('10000000'),
                    height: 100 + i,
                    fullTxHash: fh
                });
            }
            await db.endTransaction(true);

            const page1 = await tracker.getUtxosAddress(address, { limit: 2 });
            expect(page1).to.have.length(2);
            // nextCursor is non-enumerable; access directly
            expect(page1.nextCursor).to.be.a('string');
        });

    });
});

describe('XChainUtxoTracker (more)', function () {
    this.timeout(15000);
    registerTrackerHooks();

    describe('getUtxosAddress pagination', function () {
        it('returns mempool outputs only on first page (after=null)', async function () {
            const bitcoin = require('bitcoinjs-lib');
            const { createHash } = require('crypto');
            const address = 'n1wgm6kkzMcNfAtJmes8YhpvtDzdNhDY5a';
            const script = bitcoin.address.toOutputScript(address, tracker.network);
            const scriptHash = createHash('sha256').update(script).digest('hex');

            const mFh = randHash();
            await mempoolDb.beginTransaction();
            await mempoolDb.insertOutput({
                scriptPubKey: scriptHash,
                txHash: mFh.substring(0, 16),
                outputIndex: 0,
                value: BigInt('5000000'),
                height: -1,
                fullTxHash: mFh
            });
            await mempoolDb.endTransaction(true);

            // First page (after=null): should include mempool output
            const page1 = await tracker.getUtxosAddress(address, { limit: 10, after: null });
            expect(page1.some(u => u.confirmations === 0)).to.be.true;

            // Second page (after=validCursor): should NOT include mempool.
            // Cursor format must be "<txHash8Hex>:<vout>"; use a valid but non-existent one.
            const validCursor = randHash8() + ':0';
            const page2 = await tracker.getUtxosAddress(address, { limit: 10, after: validCursor });
            expect(page2.every(u => u.confirmations !== 0)).to.be.true;
        });

    });
});

describe('XChainUtxoTracker (more)', function () {
    this.timeout(15000);
    registerTrackerHooks();

    describe('getUtxosAddress pagination', function () {
        it('throws on pre-migration mempool output missing fullTxHash', async function () {
            const bitcoin = require('bitcoinjs-lib');
            const { createHash } = require('crypto');
            const address = 'n1wgm6kkzMcNfAtJmes8YhpvtDzdNhDY5a';
            const script = bitcoin.address.toOutputScript(address, tracker.network);
            const scriptHash = createHash('sha256').update(script).digest('hex');

            // Insert mempool output WITHOUT fullTxHash
            await mempoolDb.insertOutput({
                scriptPubKey: scriptHash,
                txHash: randHash8(),
                outputIndex: 0,
                value: BigInt('100000000'),
                height: -1
            });
            await mempoolDb.endTransaction(true);

            let threw = null;
            try {
                await tracker.getUtxosAddress(address);
            } catch (e) {
                threw = e;
            }
            expect(threw).to.not.be.null;
            expect(threw.message).to.match(/fullTxHash/);
            expect(threw.message).to.match(/re-index/i);
        });
    });
});
