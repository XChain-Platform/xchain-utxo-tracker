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

    describe('endTransaction(): batch error catch path', function () {
        let db;
        beforeEach(async function () { db = makeDb(); await db.createDatabase(); });
        afterEach(async function () { try { await db.close(); } catch (e) {} });

        it('throws wrapped Error when batch fails', async function () {
            // Force a batch failure by injecting a malformed item into transactionArray.
            // MemoryLevel with valueEncoding:'buffer' rejects non-Buffer values.
            await db.beginTransaction();
            const badKey = Buffer.from([0x01, 0x02]);
            // Directly inject a corrupt item; batch will fail on null value
            db.transactionArray.set('badkey', {
                type: 'put',
                key: badKey,
                value: null  // null value causes batch to fail on buffer-encoded DB
            });

            let err = null;
            try {
                await db.endTransaction(true);
            } catch (e) {
                err = e;
            }

            // Should throw the wrapped batch error
            expect(err).to.be.an('error');
            expect(err.message).to.have.string('Error in LevelDB batch inserting');
            // The atomic flush of a whole block batch is the most durability-critical
            // throw in this store, and it reaches the polling loop's top-level guard
            // and the supervisor log with nothing else attached. Pin the cause and the
            // inlined message: without them the propagated error is a constant string
            // and the real LevelDB code lives only in an earlier console line.
            expect(err.cause).to.be.an('error');
            expect(err.message).to.have.string(err.cause.message);
            // transactionArray was NOT cleared (catch re-throws before null assignment)
            expect(db.transactionArray).to.be.an.instanceOf(Map);
        });
    });

});
