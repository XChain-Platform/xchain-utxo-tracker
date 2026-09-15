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

    describe('insertOutput(): output cache eviction', function () {
        let db;
        beforeEach(async function () { db = makeDb(); await db.createDatabase(); });
        afterEach(async function () { try { await db.close(); } catch (e) {} });

        it('resets the outputCache Map when it exceeds OUTPUT_CACHE_MAX', async function () {
            // OUTPUT_CACHE_MAX = 2_000_000; too large to flood in a unit test.
            // Instead stub the cache's size property to exceed the threshold.
            const realCache = LevelUpStore.outputCache;
            const fakeCache = new Map();
            Object.defineProperty(fakeCache, 'size', { get: () => 2_000_001 });
            LevelUpStore.outputCache = fakeCache;

            const scriptHash = randHash();
            const txHash8 = randHash8();

            // insertOutput checks cache.size > OUTPUT_CACHE_MAX → resets to new Map
            await db.insertOutput({
                scriptPubKey: scriptHash,
                txHash: txHash8,
                outputIndex: 0,
                value: BigInt(1),
                height: 1
            });

            // Cache was replaced with a new (real) Map
            expect(LevelUpStore.outputCache).to.not.equal(fakeCache);

            await db.endTransaction(true);

            // Restore
            LevelUpStore.outputCache = new Map();
        });
    });

});
