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

    describe('getLastBlock(): comparison branches', function () {
        let db;
        beforeEach(async function () { db = makeDb(); await db.createDatabase(); });
        afterEach(async function () { try { await db.close(); } catch (e) {} });

        it('selects the tallest block when multiple blocks exist', async function () {
            const h1 = randHash();
            const h2 = randHash();
            const h3 = randHash();

            await db.insertBlock({ hash: h1, height: 5, timestamp: 100, previousHash: randHash() });
            await db.insertBlock({ hash: h2, height: 15, timestamp: 200, previousHash: h1 });
            await db.insertBlock({ hash: h3, height: 10, timestamp: 150, previousHash: h1 });
            await db.endTransaction(true);

            const last = await db.getLastBlock();
            expect(last.height).to.equal(15);
            expect(last.hash).to.equal(h2);
        });
    });

});
