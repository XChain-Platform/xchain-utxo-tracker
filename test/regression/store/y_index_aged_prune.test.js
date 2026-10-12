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

// Regression: cleanupAgedBlocks prunes the Y per-block tx recovery records.
//
// insertTransaction writes T, X and Y ('Y'/0x59, keyed [blockHash][txHash8]) for
// every confirmed tx. Y has exactly one reader, the reorg unwind
// (deleteTxBlockRecord), which reaches a block's txs through its W records and so
// cannot go past the undoBlocks window. An aged-out block's Y records are therefore
// unreachable; without a prune they grow by one record per tx for the life of the
// store. T and X must survive: getTxBlock reads X for every confirmed tx.

const { expect } = require('chai');
const crypto = require('crypto');
const LevelUpStore = require('../../../src/store/level_up_db');
const XChainUtxoTracker = require('../../../src/XChainUtxoTracker');

function randHash() { return crypto.randomBytes(32).toString('hex'); }
function makeDb() { return new LevelUpStore('y-prune-' + Date.now() + '-' + Math.random(), true); }

// Commits one block (B record, N window entry) holding one confirmed tx.
async function commitBlockWithTx(db, height) {
    const blockHash = randHash();
    const txid = randHash();
    await db.beginTransaction();
    await db.insertBlock({ hash: blockHash, height, timestamp: 1700000000 + height, previousHash: randHash() });
    await db.addLastStoredBlock(blockHash);
    await db.insertTransaction({ hash: txid, blockHash });
    await db.endTransaction(true);
    return { blockHash, txid };
}

describe('Regression: cleanupAgedBlocks prunes the Y recovery index (T and X survive)', function () {
    let tracker, db;

    beforeEach(async function () {
        tracker = new XChainUtxoTracker('bitcoin-regtest', '127.0.0.1', '18443', 'u', 'p', 'y-prune-db', false);
        db = makeDb(); await db.createDatabase();
        tracker.db = db;
    });
    afterEach(async function () {
        try { await db.close(); } catch (e) {}
    });

    it('aged-out block loses its Y records; the live block keeps them and both txs still resolve', async function () {
        const aged = await commitBlockWithTx(db, 100);
        const live = await commitBlockWithTx(db, 101);

        expect(await db.getValuesFromKeyPattern('59' + aged.blockHash)).to.have.length(1);
        expect(await db.getValuesFromKeyPattern('59' + live.blockHash)).to.have.length(1);

        // aged has left the reorg window; live is still inside it.
        tracker.lastBlocks = [live.blockHash];
        tracker.pendingKMCleanup = [aged.blockHash];

        await tracker.cleanupAgedBlocks();

        expect(await db.getValuesFromKeyPattern('59' + aged.blockHash)).to.be.empty;
        expect(await db.getValuesFromKeyPattern('59' + live.blockHash)).to.have.length(1);

        // X (read by getTxBlock) and T (the tx list) are kept for both blocks.
        expect((await db.getTxBlock(aged.txid)).block_hash).to.equal(aged.blockHash);
        expect((await db.getTxBlock(live.txid)).block_hash).to.equal(live.blockHash);
        expect(await db.getTransactions(aged.txid.substring(0, 16))).to.have.length(1);
    });
});

describe('Regression: removeTxBlockRecoveryIndexOnly scope', function () {
    let db;

    beforeEach(async function () {
        db = makeDb(); await db.createDatabase();
    });
    afterEach(async function () {
        try { await db.close(); } catch (e) {}
    });

    it('deletes only the given block\'s Y records', async function () {
        const a = await commitBlockWithTx(db, 200);
        const b = await commitBlockWithTx(db, 201);

        await db.beginTransaction();
        await db.removeTxBlockRecoveryIndexOnly(a.blockHash);
        await db.endTransaction(true);

        expect(await db.getValuesFromKeyPattern('59' + a.blockHash)).to.be.empty;
        expect(await db.getValuesFromKeyPattern('59' + b.blockHash)).to.have.length(1);
    });

    it('no-ops for a block with no Y records', async function () {
        const a = await commitBlockWithTx(db, 300);

        await db.beginTransaction();
        await db.removeTxBlockRecoveryIndexOnly(randHash());
        await db.endTransaction(true);

        expect(await db.getValuesFromKeyPattern('59' + a.blockHash)).to.have.length(1);
    });
});
