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

    describe('pagination cursor edge cases', function () {
        let db;
        beforeEach(async function () { db = makeDb(); await db.createDatabase(); });
        afterEach(async function () { try { await db.close(); } catch (e) {} });

        const cursorCases = [
            ['non-string (number)', 42],
            ['no colon', 'deadbeefdeadbeef'],
            ['colon at position 0', ':0'],
            ['txHash8 too short (14 hex)', 'deadbeefdeadbe:0'],
            ['txHash8 not hex', 'gggggggggggggggg:0'],
            ['vout not digits', 'deadbeefdeadbeef:abc'],
            ['vout > 0xFFFFFFFF', 'deadbeefdeadbeef:4294967296'],
        ];

        for (const [label, cursor] of cursorCases) {
            it(`throws INVALID_CURSOR for ${label}`, async function () {
                const scriptHash = randHash();
                let err = null;
                try {
                    await db.getOutputsScriptPubKey(scriptHash, { after: cursor });
                } catch (e) {
                    err = e;
                }
                expect(err, `expected INVALID_CURSOR for cursor ${JSON.stringify(cursor)}`).to.be.an('error');
                expect(err.code).to.equal('INVALID_CURSOR');
            });
        }
    });

});
