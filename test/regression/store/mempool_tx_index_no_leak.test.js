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

// Regression: a mempool insertTransaction writes T only.
//
// The mempool store is created once per process and never reset. Its eviction
// diff deletes T by 8-byte prefix and nothing scans a zero-hash Y range, so an
// X or Y record written for a blockHash-less tx would outlive the tx and grow
// the store by every mempool tx ever seen. Confirmed inserts keep T, X and Y.

const { expect } = require('chai');
const crypto = require('crypto');
const LevelUpStore = require('../../../src/store/level_up_db');

function randHash() { return crypto.randomBytes(32).toString('hex'); }
function makeDb() { return new LevelUpStore('mempool-ti-' + Date.now() + '-' + Math.random(), true); }

// Counts every committed key under a one-byte prefix (getValuesFromKeyPattern needs two).
async function countPrefix(db, byte) {
    let n = 0;
    const range = { gte: Buffer.from([byte]), lt: Buffer.from([byte + 1]), keys: true, values: false };
    for await (const _ of db.db.iterator(range)) n++; // eslint-disable-line no-unused-vars
    return n;
}

describe('Regression: mempool insertTransaction leaves no X or Y records', function () {
    let db;

    beforeEach(async function () { db = makeDb(); await db.createDatabase(); });
    afterEach(async function () { try { await db.close(); } catch (e) {} });

    it('writes only T for a tx with no blockHash', async function () {
        const txid = randHash();
        await db.beginTransaction();
        await db.insertTransaction({ hash: txid, blockHash: null });
        await db.endTransaction(true);

        expect(await db.getValuesFromKeyPattern('58' + txid)).to.be.empty;
        expect(await db.getValuesFromKeyPattern('59' + '0'.repeat(64))).to.be.empty;
        expect(await db.getTransactions(txid.substring(0, 16))).to.have.length(1);
    });

    it('leaves no X or Y behind after mempool eviction', async function () {
        const txids = [randHash(), randHash(), randHash()];
        await db.beginTransaction();
        for (const txid of txids) await db.insertTransaction({ hash: txid, blockHash: null });
        await db.endTransaction(true);

        await db.beginTransaction();
        await db.deleteAndCompareTxsNotInList([]);
        await db.endTransaction(true);

        expect(await countPrefix(db, 0x58)).to.equal(0);
        expect(await countPrefix(db, 0x59)).to.equal(0);
        for (const txid of txids) {
            expect(await db.getTransactions(txid.substring(0, 16))).to.be.empty;
        }
    });

    it('still writes T, X and Y for a confirmed tx', async function () {
        const txid = randHash();
        const blockHash = randHash();
        await db.beginTransaction();
        await db.insertTransaction({ hash: txid, blockHash });
        await db.endTransaction(true);

        expect(await db.getValuesFromKeyPattern('58' + txid)).to.have.length(1);
        expect(await db.getValuesFromKeyPattern('59' + blockHash)).to.have.length(1);
        expect(await db.getTransactions(txid.substring(0, 16))).to.have.length(1);
    });
});
