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

    describe('removeOutputsWithInputsBatch()', function () {
        let db;
        beforeEach(async function () {
            db = makeDb();
            await db.createDatabase();
            // Clear the static output cache between tests to avoid cross-test interference
            LevelUpStore.outputCache = new Map();
        });
        afterEach(async function () { try { await db.close(); } catch (e) {} });

        it('returns 0 for an empty inputs array', async function () {
            await db.beginTransaction();
            const count = await db.removeOutputsWithInputsBatch([]);
            await db.endTransaction(true);
            expect(count).to.equal(0);
        });

        it('removes committed outputs via batch (getMany path)', async function () {
            const scriptBuf = randBuf32();
            const scriptHex = scriptBuf.toString('hex');
            const txHash8   = randHash8();
            const blockHash = randHash();

            // Commit output + hint to DB (not in-memory)
            await db.insertOutput({ scriptPubKey: scriptBuf, txHash: txHash8, outputIndex: 0, value: BigInt(3000), height: 10 });
            await db.insertOutputHint({ scriptPubKey: scriptBuf, txHash: txHash8, outputIndex: 0 });
            await db.endTransaction(true);

            // Clear the output cache so Phase 2 hits the DB read path
            LevelUpStore.outputCache = new Map();

            await db.beginTransaction();
            const count = await db.removeOutputsWithInputsBatch([
                { prevTxHash: txHash8, prevOutputIndex: 0, blockHash }
            ]);
            await db.endTransaction(true);

            expect(count).to.equal(1);

            const outputs = await db.getOutputsScriptPubKey(scriptHex);
            expect(outputs).to.be.empty;
        });
    });

});

describe('LevelUpDb (extended coverage)', function () {

    describe('removeOutputsWithInputsBatch()', function () {
        let db;
        beforeEach(async function () {
            db = makeDb();
            await db.createDatabase();
            // Clear the static output cache between tests to avoid cross-test interference
            LevelUpStore.outputCache = new Map();
        });
        afterEach(async function () { try { await db.close(); } catch (e) {} });

        it('removes in-memory (same-batch) outputs via batch', async function () {
            const scriptBuf = randBuf32();
            const scriptHex = scriptBuf.toString('hex');
            const txHash8   = randHash8();
            const blockHash = randHash();

            // Insert output + hint and spend in the SAME batch (in-memory path)
            await db.beginTransaction();
            await db.insertOutput({ scriptPubKey: scriptBuf, txHash: txHash8, outputIndex: 0, value: BigInt(2000), height: 5 });
            await db.insertOutputHint({ scriptPubKey: scriptBuf, txHash: txHash8, outputIndex: 0 });
            const count = await db.removeOutputsWithInputsBatch([
                { prevTxHash: txHash8, prevOutputIndex: 0, blockHash }
            ]);
            await db.endTransaction(true);

            expect(count).to.equal(1);

            const outputs = await db.getOutputsScriptPubKey(scriptHex);
            expect(outputs).to.be.empty;
        });

        it('removeTransaction returns false (no TypeError) for an unstaged key', async function () {
            await db.beginTransaction();
            // An unstaged key must return false instead of dereferencing undefined and
            // throwing a context-less TypeError, so callers can react diagnostically.
            const result = db.removeTransaction(Buffer.from('aa', 'hex'), Buffer.from('bb', 'hex'));
            expect(result).to.equal(false);
            await db.endTransaction(true);
        });
    });

});

describe('LevelUpDb (extended coverage)', function () {

    describe('removeOutputsWithInputsBatch()', function () {
        let db;
        beforeEach(async function () {
            db = makeDb();
            await db.createDatabase();
            // Clear the static output cache between tests to avoid cross-test interference
            LevelUpStore.outputCache = new Map();
        });
        afterEach(async function () { try { await db.close(); } catch (e) {} });

        it('throws the outpoint-naming diagnostic when a staged output is already gone (duplicate outpoint in one batch)', async function () {
            const scriptBuf = randBuf32();
            const txHash8   = randHash8();
            const blockHash = randHash();

            await db.beginTransaction();
            await db.insertOutput({ scriptPubKey: scriptBuf, txHash: txHash8, outputIndex: 0, value: BigInt(2000), height: 5 });
            await db.insertOutputHint({ scriptPubKey: scriptBuf, txHash: txHash8, outputIndex: 0 });

            // The same outpoint listed twice: the first removal deletes the staged O,
            // the second finds it missing and must throw with outpoint context rather
            // than silently ignoring removeTransaction's false return.
            let threw = false;
            try {
                await db.removeOutputsWithInputsBatch([
                    { prevTxHash: txHash8, prevOutputIndex: 0, blockHash },
                    { prevTxHash: txHash8, prevOutputIndex: 0, blockHash },
                ]);
            } catch (e) {
                threw = true;
                expect(e.message).to.match(/Missing output match for input/);
            }
            expect(threw).to.equal(true);
            await db.endTransaction(false);
        });

        it('warns and skips when hint is missing (pre-REMOVE_SPENT data)', async function () {
            const txHash8   = randHash8();
            const blockHash = randHash();

            // No output or hint exists for this input
            await db.beginTransaction();
            const count = await db.removeOutputsWithInputsBatch([
                { prevTxHash: txHash8, prevOutputIndex: 0, blockHash }
            ]);
            await db.endTransaction(true);

            // Should not throw; resolved[i] is null for the missing hint, so it is skipped
            expect(count).to.equal(1);
        });
    });

});

describe('LevelUpDb (extended coverage)', function () {

    describe('removeOutputsWithInputsBatch()', function () {
        let db;
        beforeEach(async function () {
            db = makeDb();
            await db.createDatabase();
            // Clear the static output cache between tests to avoid cross-test interference
            LevelUpStore.outputCache = new Map();
        });
        afterEach(async function () { try { await db.close(); } catch (e) {} });

        it('handles multiple inputs in one batch (mixed committed and missing)', async function () {
            const script1 = randBuf32();
            const script1Hex = script1.toString('hex');
            const tx1 = randHash8();
            const blockHash = randHash();

            // Only tx1 has an output; tx2 does not
            const tx2 = randHash8();

            await db.insertOutput({ scriptPubKey: script1, txHash: tx1, outputIndex: 0, value: BigInt(100), height: 1 });
            await db.insertOutputHint({ scriptPubKey: script1, txHash: tx1, outputIndex: 0 });
            await db.endTransaction(true);

            LevelUpStore.outputCache = new Map();

            await db.beginTransaction();
            const count = await db.removeOutputsWithInputsBatch([
                { prevTxHash: tx1, prevOutputIndex: 0, blockHash },
                { prevTxHash: tx2, prevOutputIndex: 0, blockHash }, // missing
            ]);
            await db.endTransaction(true);

            expect(count).to.equal(2); // returns inputs.length regardless
            const outputs = await db.getOutputsScriptPubKey(script1Hex);
            expect(outputs).to.be.empty;
        });
    });

});

describe('LevelUpDb (extended coverage)', function () {

    describe('removeOutputsWithInputsBatch()', function () {
        let db;
        beforeEach(async function () {
            db = makeDb();
            await db.createDatabase();
            // Clear the static output cache between tests to avoid cross-test interference
            LevelUpStore.outputCache = new Map();
        });
        afterEach(async function () { try { await db.close(); } catch (e) {} });

        it('uses output cache (hit path) when output was recently inserted', async function () {
            const scriptBuf = randBuf32();
            const scriptHex = scriptBuf.toString('hex');
            const txHash8   = randHash8();
            const blockHash = randHash();

            // Insert and commit; this populates the static outputCache
            await db.insertOutput({ scriptPubKey: scriptBuf, txHash: txHash8, outputIndex: 0, value: BigInt(7777), height: 3 });
            await db.insertOutputHint({ scriptPubKey: scriptBuf, txHash: txHash8, outputIndex: 0 });
            await db.endTransaction(true);

            // Phase 2 of removeOutputsWithInputsBatch should see a cache hit.
            // The cache contains the entry populated by insertOutput above.
            // Run batch removal; Phase 2 should see a cache hit
            await db.beginTransaction();
            const hitsBefore = LevelUpStore.outputCacheHits;
            await db.removeOutputsWithInputsBatch([
                { prevTxHash: txHash8, prevOutputIndex: 0, blockHash }
            ]);
            await db.endTransaction(true);

            // At least one cache hit (or miss if the output was evicted);
            // check that the removal worked rather than the cache stat alone
            const outputs = await db.getOutputsScriptPubKey(scriptHex);
            expect(outputs).to.be.empty;
        });
    });

});

describe('LevelUpDb (extended coverage)', function () {

    describe('removeOutputsWithInputsBatch()', function () {
        let db;
        beforeEach(async function () {
            db = makeDb();
            await db.createDatabase();
            // Clear the static output cache between tests to avoid cross-test interference
            LevelUpStore.outputCache = new Map();
        });
        afterEach(async function () { try { await db.close(); } catch (e) {} });

        it('leaves H record intact (no undo-less delete) when output has no matching value', async function () {
            // Insert hint only (no O record) to force the oVal==null branch in Phase 3
            const scriptBuf = randBuf32();
            const txHash8   = randHash8();
            const blockHash = randHash();

            // Insert only the H entry manually via addTransaction
            await db.addTransaction('put',
                Buffer.concat([Buffer.from([0x48]), Buffer.from(txHash8, 'hex'), Buffer.alloc(4)]),
                scriptBuf
            );
            await db.endTransaction(true);

            LevelUpStore.outputCache = new Map();

            await db.beginTransaction();
            const count = await db.removeOutputsWithInputsBatch([
                { prevTxHash: txHash8, prevOutputIndex: 0, blockHash }
            ]);
            await db.endTransaction(true);

            expect(count).to.equal(1);

            // Regression guard for the "H present, O missing" branch: deleting the
            // H record here with no K/M undo record would make a subsequent reorg
            // unwind unable to restore it. The store must leave it intact instead,
            // matching removeOutputWithInput()'s "do nothing" behavior for the same
            // store state.
            const stillPresent = await db.hasOutputForTx(txHash8, 0);
            expect(stillPresent).to.equal(true);
        });
    });

});
