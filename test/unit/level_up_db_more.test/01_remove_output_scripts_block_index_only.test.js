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

    describe('removeOutputScriptsBlockIndexOnly()', function () {
        let db;
        beforeEach(async function () {
            LevelUpStore.knownScripts = new Set();
            db = makeDb(); await db.createDatabase();
        });
        afterEach(async function () {
            try { await db.close(); } catch (e) {}
            LevelUpStore.knownScripts = new Set();
        });

        it('deletes the Z reverse-index for the block but LEAVES the S first-seen record', async function () {
            const scriptBuf = randBuf32();
            const scriptHex = scriptBuf.toString('hex');
            const blockHash = randHash();

            await db.insertOutputScriptBlock(scriptBuf, blockHash, 50);
            await db.endTransaction(true);

            // Z entry present ('5a' prefix), S first-seen resolvable
            expect(await db.getValuesFromKeyPattern('5a' + blockHash)).to.have.length(1);
            expect(await db.getOutputScriptBlock(scriptHex)).to.deep.equal({ h: 50 });

            // Aged-out prune: drop only the Z index for this block
            await db.beginTransaction();
            await db.removeOutputScriptsBlockIndexOnly(blockHash);
            await db.endTransaction(true);

            // Z gone; the S first-seen record must survive (it backs getFirstSeen),
            // unlike the reorg path (removeOutputScriptsInBlock) which deletes both.
            expect(await db.getValuesFromKeyPattern('5a' + blockHash)).to.be.empty;
            expect(await db.getOutputScriptBlock(scriptHex)).to.deep.equal({ h: 50 });
        });

        it('only prunes the given block, leaving other blocks\' Z entries intact', async function () {
            const blockA = randHash();
            const blockB = randHash();

            await db.insertOutputScriptBlock(randBuf32(), blockA, 10);
            await db.insertOutputScriptBlock(randBuf32(), blockB, 11);
            await db.endTransaction(true);

            await db.beginTransaction();
            await db.removeOutputScriptsBlockIndexOnly(blockA);
            await db.endTransaction(true);

            expect(await db.getValuesFromKeyPattern('5a' + blockA)).to.be.empty;
            expect(await db.getValuesFromKeyPattern('5a' + blockB)).to.have.length(1);
        });

        it('no-ops when no Z entries exist for the block', async function () {
            await db.beginTransaction();
            await db.removeOutputScriptsBlockIndexOnly(randHash());
            await db.endTransaction(true);
        });
    });

});
