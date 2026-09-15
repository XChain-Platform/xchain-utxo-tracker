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

    describe('getValuesFromKeyPattern() with Buffer pattern', function () {
        let db;
        beforeEach(async function () { db = makeDb(); await db.createDatabase(); });
        afterEach(async function () { try { await db.close(); } catch (e) {} });

        it('accepts a Buffer as pattern and returns matching entries', async function () {
            const scriptHash = randHash();
            const txHash8    = randHash8();
            await db.insertOutput({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 0, value: BigInt(200), height: 2 });
            await db.endTransaction(true);

            // Build the O-prefix Buffer directly
            const patternBuf = Buffer.concat([Buffer.from([0x4f]), Buffer.from(scriptHash, 'hex')]);
            const results = await db.getValuesFromKeyPattern(patternBuf);
            expect(results).to.have.length(1);
        });
    });

});
