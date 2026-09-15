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

    describe('insertOutputScriptBlock(): tier cache paths', function () {
        let db;
        beforeEach(async function () {
            db = makeDb();
            await db.createDatabase();
            // Reset shared static caches to prevent cross-test interference
            LevelUpStore.knownScripts = new Set();
        });
        afterEach(async function () { try { await db.close(); } catch (e) {} });

        it('Tier 0: returns early (knownScripts cache hit) without DB access', async function () {
            const scriptHex = randHash();
            const blockHash = randHash();

            // Insert once to add to knownScripts
            await db.insertOutputScriptBlock(scriptHex, blockHash, 100);
            await db.endTransaction(true);

            // Second call in a fresh batch: should hit Tier 0 and return without any DB/batch op
            await db.beginTransaction();
            const hitsBefore = LevelUpStore.knownScriptsHits;
            await db.insertOutputScriptBlock(scriptHex, blockHash, 200);
            await db.endTransaction(true);

            expect(LevelUpStore.knownScriptsHits).to.be.gt(hitsBefore);

            // Height should still be 100 (first insertion, not overwritten)
            const result = await db.getOutputScriptBlock(scriptHex);
            expect(result.h).to.equal(100);
        });

        it('Tier 1: detects script already in pending batch (no DB read needed)', async function () {
            const scriptHex = randHash();
            const blockHash  = randHash();

            // Clear knownScripts so Tier 0 doesn't fire
            LevelUpStore.knownScripts = new Set();

            // First call: writes S entry into the pending batch
            await db.insertOutputScriptBlock(scriptHex, blockHash, 10);

            // Second call in the SAME batch: Tier 1 should see it in transactionArray
            LevelUpStore.knownScripts = new Set(); // force Tier 0 miss again
            const missesBefore = LevelUpStore.knownScriptsMisses;
            await db.insertOutputScriptBlock(scriptHex, blockHash, 20);

            // Both calls happened before endTransaction; Tier 1 path taken on 2nd call
            await db.endTransaction(true);

            // Height should be 10 (from first call; second was a no-op)
            const result = await db.getOutputScriptBlock(scriptHex);
            expect(result.h).to.equal(10);
        });
    });

});

describe('LevelUpDb (extended coverage)', function () {

    describe('insertOutputScriptBlock(): tier cache paths', function () {
        let db;
        beforeEach(async function () {
            db = makeDb();
            await db.createDatabase();
            // Reset shared static caches to prevent cross-test interference
            LevelUpStore.knownScripts = new Set();
        });
        afterEach(async function () { try { await db.close(); } catch (e) {} });

        it('Tier 2: detects script already in DB (committed, cache miss)', async function () {
            const scriptHex = randHash();
            const blockHash  = randHash();

            // Insert and commit to DB
            await db.insertOutputScriptBlock(scriptHex, blockHash, 5);
            await db.endTransaction(true);

            // Clear both Tier 0 and Tier 1 so the DB lookup fires
            LevelUpStore.knownScripts = new Set();
            await db.beginTransaction(); // fresh batch so Tier 1 is empty

            const hitsBefore = LevelUpStore.knownScriptsHits;
            await db.insertOutputScriptBlock(scriptHex, blockHash, 99);
            await db.endTransaction(true);

            // Height remains 5; the second call was rejected by Tier 2
            const result = await db.getOutputScriptBlock(scriptHex);
            expect(result.h).to.equal(5);
        });

        it('works with Buffer scriptPubKey (kScriptBlkFromBuf / kBlkScriptFromBuf paths)', async function () {
            const scriptBuf = randBuf32();
            const scriptHex = scriptBuf.toString('hex');
            const blockHash  = randHash();

            LevelUpStore.knownScripts = new Set();
            await db.insertOutputScriptBlock(scriptBuf, blockHash, 77);  // Buffer path
            await db.endTransaction(true);

            const result = await db.getOutputScriptBlock(scriptHex);
            expect(result).to.not.be.null;
            expect(result.h).to.equal(77);
        });
    });

});

describe('LevelUpDb (extended coverage)', function () {

    describe('insertOutputScriptBlock(): tier cache paths', function () {
        let db;
        beforeEach(async function () {
            db = makeDb();
            await db.createDatabase();
            // Reset shared static caches to prevent cross-test interference
            LevelUpStore.knownScripts = new Set();
        });
        afterEach(async function () { try { await db.close(); } catch (e) {} });

        it('knownScripts cache resets when size exceeds KNOWN_SCRIPTS_MAX', async function () {
            // KNOWN_SCRIPTS_MAX = 2_000_000; we can't flood it in a unit test.
            // Instead, replace the Set with a stub whose .size reports over the limit.
            const realSet = LevelUpStore.knownScripts;
            const fakeSet = new Set();
            Object.defineProperty(fakeSet, 'size', { get: () => 2_000_001 });
            LevelUpStore.knownScripts = fakeSet;

            const scriptHex = randHash();
            const blockHash  = randHash();

            // The cache-reset branch fires before the rest of the function
            await db.insertOutputScriptBlock(scriptHex, blockHash, 42);
            await db.endTransaction(true);

            // knownScripts was replaced with a new Set (the stub was discarded)
            expect(LevelUpStore.knownScripts).to.not.equal(fakeSet);

            const result = await db.getOutputScriptBlock(scriptHex);
            expect(result.h).to.equal(42);
        });
    });

});
