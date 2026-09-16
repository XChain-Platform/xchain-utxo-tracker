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

    describe('deleteOutputsByHints()', function () {
        let db;
        beforeEach(async function () { db = makeDb(); await db.createDatabase(); });
        afterEach(async function () { try { await db.close(); } catch (e) {} });

        it('deletes all outputs across multiple txids', async function () {
            const script1 = randHash();
            const script2 = randHash();
            const tx1     = randHash8();
            const tx2     = randHash8();

            await db.insertOutput({ scriptPubKey: script1, txHash: tx1, outputIndex: 0, value: BigInt(1), height: 1 });
            await db.insertOutputHint({ scriptPubKey: script1, txHash: tx1, outputIndex: 0 });
            await db.insertOutput({ scriptPubKey: script2, txHash: tx2, outputIndex: 0, value: BigInt(2), height: 2 });
            await db.insertOutputHint({ scriptPubKey: script2, txHash: tx2, outputIndex: 0 });
            await db.endTransaction(true);

            await db.beginTransaction();
            const total = await db.deleteOutputsByHints([
                tx1 + randHash().substring(16),
                tx2 + randHash().substring(16),
            ]);
            await db.endTransaction(true);

            expect(total).to.equal(2);
            expect(await db.getOutputsScriptPubKey(script1)).to.be.empty;
            expect(await db.getOutputsScriptPubKey(script2)).to.be.empty;
        });
    });

});
