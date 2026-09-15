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

    describe('encodeOutput/decodeOutput with height=-1', function () {
        let db;
        beforeEach(async function () { db = makeDb(); await db.createDatabase(); });
        afterEach(async function () { try { await db.close(); } catch (e) {} });

        it('stores and retrieves height -1 correctly (mempool sentinel)', async function () {
            const scriptHash = randHash();
            await db.insertOutput({
                scriptPubKey: scriptHash,
                txHash: randHash8(),
                outputIndex: 0,
                value: BigInt(1000),
                height: -1  // mempool / no-height sentinel
            });
            await db.endTransaction(true);

            const outputs = await db.getOutputsScriptPubKey(scriptHash);
            expect(outputs).to.have.length(1);
            expect(outputs[0].height).to.equal(-1);
        });
    });

});
