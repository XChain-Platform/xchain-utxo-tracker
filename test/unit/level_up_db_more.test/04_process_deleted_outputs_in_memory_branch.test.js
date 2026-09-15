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

    describe('processDeletedOutputs(): in-memory branch', function () {
        let db;
        beforeEach(async function () { db = makeDb(); await db.createDatabase(); });
        afterEach(async function () { try { await db.close(); } catch (e) {} });

        it('recovers a removed output under its ORIGINAL key (regression: latin1 vs hex)', async function () {
            // Regression for the in-memory recovery key-encoding bug: the recovery
            // else-branch must rebuild the original key Buffer with 'latin1' (the
            // inverse of toMapKey), NOT h2b/'hex'. With the old h2b path the key was
            // corrupted, so the reorg-recovered output never reappeared in the DB.
            const scriptBuf = randBuf32();
            const scriptHex = scriptBuf.toString('hex');
            const txHash8   = randHash8();
            const blockHash = randHash();

            await db.beginTransaction();
            await db.insertOutput({ scriptPubKey: scriptBuf, txHash: txHash8, outputIndex: 0, value: BigInt(4000), height: 7 });
            await db.insertOutputHint({ scriptPubKey: scriptBuf, txHash: txHash8, outputIndex: 0 });

            // removeOutputWithInput on an in-memory entry populates deletedTransactionArray
            // and removes the O-key from transactionArray (forcing the else-branch on recovery).
            await db.removeOutputWithInput({ prevTxHash: txHash8, prevOutputIndex: 0, blockHash });
            expect(db.deletedTransactionArray.has(blockHash)).to.be.true;

            // Recover (reorg undo); exercises the in-memory else-branch.
            await db.processDeletedOutputs(blockHash, true);
            expect(db.deletedTransactionArray.has(blockHash)).to.be.false;

            await db.endTransaction(true);

            // The output must be queryable again under its real script key, proving the
            // recovered key Buffer was rebuilt correctly (latin1), not corrupted (hex).
            const outputs = await db.getOutputsScriptPubKey(scriptHex);
            expect(outputs).to.have.length(1);
            expect(Number(outputs[0].value)).to.equal(4000);
        });
    });

});

describe('LevelUpDb (extended coverage)', function () {

    describe('processDeletedOutputs(): in-memory branch', function () {
        let db;
        beforeEach(async function () { db = makeDb(); await db.createDatabase(); });
        afterEach(async function () { try { await db.close(); } catch (e) {} });

        it('purges in-memory deletedTransactionArray without recovery when recover=false', async function () {
            const scriptBuf = randBuf32();
            const scriptHex = scriptBuf.toString('hex');
            const txHash8   = randHash8();
            const blockHash = randHash();

            await db.beginTransaction();
            await db.insertOutput({ scriptPubKey: scriptBuf, txHash: txHash8, outputIndex: 0, value: BigInt(1234), height: 3 });
            await db.insertOutputHint({ scriptPubKey: scriptBuf, txHash: txHash8, outputIndex: 0 });
            await db.removeOutputWithInput({ prevTxHash: txHash8, prevOutputIndex: 0, blockHash });

            // deletedTransactionArray should have an entry before purge
            expect(db.deletedTransactionArray.has(blockHash)).to.be.true;

            // Purge without recovery (recover=false)
            await db.processDeletedOutputs(blockHash, false);

            // After purge, entry is cleared regardless of recover flag
            expect(db.deletedTransactionArray.has(blockHash)).to.be.false;

            await db.endTransaction(true);

            const outputs = await db.getOutputsScriptPubKey(scriptHex);
            expect(outputs).to.be.empty;
        });
    });

});
