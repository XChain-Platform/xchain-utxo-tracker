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

let db;

async function deleteInputsAcrossTxids() {
    const prev1 = randHash();
    const prev2 = randHash();
    const tx1 = randHash();
    const tx2 = randHash();
    await db.insertInput({ prevTxHash: prev1, prevOutputIndex: 0, txHash: tx1 });
    await db.insertInputHint({ prevTxHash: prev1, prevOutputIndex: 0, txHash: tx1 });
    await db.insertInput({ prevTxHash: prev2, prevOutputIndex: 0, txHash: tx2 });
    await db.insertInputHint({ prevTxHash: prev2, prevOutputIndex: 0, txHash: tx2 });
    await db.endTransaction(true);
    await db.beginTransaction();
    const total = await db.deleteInputsByHints([tx1, tx2]);
    await db.endTransaction(true);
    expect(total).to.equal(2);
    expect(await db.getInput(prev1, 0)).to.be.null;
    expect(await db.getInput(prev2, 0)).to.be.null;
}

async function preserveSurvivingReplacement() {
    const prev = randHash();
    const original = randHash();
    const replacement = randHash();
    await db.insertInput({ prevTxHash: prev, prevOutputIndex: 0, txHash: replacement });
    await db.insertInputHint({ prevTxHash: prev, prevOutputIndex: 0, txHash: original });
    await db.insertInputHint({ prevTxHash: prev, prevOutputIndex: 0, txHash: replacement });
    await db.endTransaction(true);
    await db.beginTransaction();
    expect(await db.deleteInputsByHint(original)).to.equal(1);
    await db.endTransaction(true);
    expect(Buffer.from(await db.getInput(prev, 0)).equals(Buffer.from(replacement, 'hex'))).to.equal(true);
    await db.beginTransaction();
    expect(await db.deleteInputsByHint(replacement)).to.equal(1);
    await db.endTransaction(true);
    expect(await db.getInput(prev, 0)).to.be.null;
}

async function deleteSharedSpendMarker() {
    const prev = randHash();
    const original = randHash();
    const replacement = randHash();
    await db.insertInput({ prevTxHash: prev, prevOutputIndex: 0, txHash: replacement });
    await db.insertInputHint({ prevTxHash: prev, prevOutputIndex: 0, txHash: original });
    await db.insertInputHint({ prevTxHash: prev, prevOutputIndex: 0, txHash: replacement });
    await db.endTransaction(true);
    await db.beginTransaction();
    expect(await db.deleteInputsByHints([original, replacement])).to.equal(2);
    await db.endTransaction(true);
    expect(await db.getInput(prev, 0)).to.be.null;
}

describe('LevelUpDb (extended coverage)', function () {
    describe('deleteInputsByHints()', function () {
        beforeEach(async function () { db = makeDb(); await db.createDatabase(); });
        afterEach(async function () { try { await db.close(); } catch (e) {} });
        it('deletes all inputs across multiple txids', deleteInputsAcrossTxids);
        it('preserves a spend marker owned by a surviving replacement', preserveSurvivingReplacement);
        it('deletes a shared spend marker when its owner is pruned in the same batch', deleteSharedSpendMarker);
    });
});
