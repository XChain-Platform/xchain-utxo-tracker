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

    describe('removeLastStoredBlock(): error branch', function () {
        let db;
        beforeEach(async function () { db = makeDb(); await db.createDatabase(); });
        afterEach(async function () { try { await db.close(); } catch (e) {} });

        it('calls through addTransaction del path when key is not in pending batch', async function () {
            const blockHash = randHash();

            // Add and commit the block, then remove in a fresh batch
            await db.addLastStoredBlock(blockHash);
            await db.endTransaction(true);

            await db.beginTransaction();
            const result = await db.removeLastStoredBlock(blockHash);
            await db.endTransaction(true);

            expect(result).to.be.true;
            const blocks = await db.getLastStoredBlocks();
            expect(blocks).to.not.include(blockHash);
        });

        it('removeTransactionIfExists returns true and skips addTransaction when key IS in pending batch', async function () {
            const blockHash = randHash();

            // Add the block in a batch but do NOT commit yet, then remove it
            // from the same in-flight batch.
            // Add the block in a batch but do NOT commit yet
            await db.addLastStoredBlock(blockHash);
            const result = await db.removeLastStoredBlock(blockHash);
            await db.endTransaction(true);

            expect(result).to.be.true;
            const blocks = await db.getLastStoredBlocks();
            expect(blocks).to.not.include(blockHash);
        });
    });

});
