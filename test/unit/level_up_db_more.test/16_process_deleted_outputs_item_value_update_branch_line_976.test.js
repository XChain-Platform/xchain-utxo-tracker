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

// Additional unit tests for LevelUpDb.js covering uncovered lines not reached
// by LevelUpDb.test.js. All stores use in-memory MemoryLevel (no disk).

const { expect } = require('chai');
const crypto = require('crypto');
const LevelUpStore = require('../../../src/store/level_up_db');

function randHash() { return crypto.randomBytes(32).toString('hex'); }
function randHash8() { return crypto.randomBytes(8).toString('hex'); }
function randBuf32() { return crypto.randomBytes(32); }

let dbCounter = 0;
function makeDb() {
    return new LevelUpStore('more-test-' + Date.now() + '-' + (++dbCounter), true);
}

describe('LevelUpDb (extended coverage)', function () {

    describe('processDeletedOutputs(): item.value update branch (line 976)', function () {
        let db;
        beforeEach(async function () { db = makeDb(); await db.createDatabase(); });
        afterEach(async function () { try { await db.close(); } catch (e) {} });

        it('updates the value of an existing transactionArray entry when recovering', async function () {
            const blockHash = randHash();

            await db.beginTransaction();

            // Manually place a key in BOTH transactionArray AND deletedTransactionArray
            // under the same map-key. This simulates the scenario where a key was
            // re-added to transactionArray after being removed by removeTransaction.
            const fakeKey = Buffer.allocUnsafe(13); // any binary key
            crypto.randomBytes(13).copy(fakeKey);
            const originalVal = Buffer.from('original');
            const recoveredVal = Buffer.from('recovered');

            // Add the key to transactionArray with originalVal
            await db.addTransaction('put', fakeKey, originalVal);

            // Manually register it in deletedTransactionArray with recoveredVal
            // (mimics what removeTransaction followed by recovery should do)
            const mapKey = fakeKey.toString('latin1'); // toMapKey on Buffer
            if (!db.deletedTransactionArray.has(blockHash)) {
                db.deletedTransactionArray.set(blockHash, new Map());
            }
            db.deletedTransactionArray.get(blockHash).set(mapKey, recoveredVal);

            // processDeletedOutputs(recover=true) finds item in transactionArray → line 976
            await db.processDeletedOutputs(blockHash, true);

            // The item's value should have been updated to recoveredVal
            const item = db.transactionArray.get(mapKey);
            expect(item).to.not.be.undefined;
            expect(item.value).to.deep.equal(recoveredVal);

            await db.endTransaction(true);
        });
    });

});
