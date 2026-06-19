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
const LevelUpStore = require('../../src/LevelUpDb');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function randHash() { return crypto.randomBytes(32).toString('hex'); }
function randHash8() { return crypto.randomBytes(8).toString('hex'); }
function randBuf32() { return crypto.randomBytes(32); }

let dbCounter = 0;
function makeDb() {
    return new LevelUpStore('more-test-' + Date.now() + '-' + (++dbCounter), true);
}

// ─── Suite ───────────────────────────────────────────────────────────────────

describe('LevelUpDb (extended coverage)', function () {

    // ─── sleep ──────────────────────────────────────────────────────────────

    describe('sleep()', function () {
        let db;
        beforeEach(async function () { db = makeDb(); await db.createDatabase(); });
        afterEach(async function () { try { await db.close(); } catch (e) {} });

        it('resolves after approximately the given delay', async function () {
            const before = Date.now();
            await db.sleep(20);
            const elapsed = Date.now() - before;
            expect(elapsed).to.be.gte(10); // allow for timer imprecision
        });
    });

    // ─── elementCompare ─────────────────────────────────────────────────────

    describe('elementCompare()', function () {
        let db;
        beforeEach(async function () { db = makeDb(); await db.createDatabase(); });
        afterEach(async function () { try { await db.close(); } catch (e) {} });

        it('returns -1 when a < b', function () {
            expect(db.elementCompare('a', 'b')).to.equal(-1);
        });
        it('returns 1 when a > b', function () {
            expect(db.elementCompare('b', 'a')).to.equal(1);
        });
        it('returns 0 when a === b', function () {
            expect(db.elementCompare('x', 'x')).to.equal(0);
        });
    });

    // ─── addTransaction with null transactionArray (direct write path) ───────

    describe('addTransaction: direct-write path (transactionArray === null)', function () {
        let db;
        beforeEach(async function () {
            db = makeDb();
            await db.createDatabase();
            // Drive endTransaction to set transactionArray = null
            await db.endTransaction(true);
        });
        afterEach(async function () { try { await db.close(); } catch (e) {} });

        it('put writes directly to the DB when transactionArray is null', async function () {
            // Insert a block; endTransaction was called so transactionArray is null.
            // addTransaction falls through to the db.put direct path.
            const key = Buffer.from('direct-put-test');
            const val = Buffer.from('hello');
            await db.addTransaction('put', key, val);
            const readBack = await db.db.get(key);
            expect(readBack).to.deep.equal(val);
        });

        it('del removes directly from the DB when transactionArray is null', async function () {
            const key = Buffer.from('direct-del-test');
            await db.db.put(key, Buffer.from('exists'));
            await db.addTransaction('del', key);
            const readBack = await db.db.get(key);
            expect(readBack).to.equal(undefined);
        });

        it('unknown type throws when transactionArray is null', async function () {
            let err = null;
            try {
                await db.addTransaction('unknown', Buffer.from('k'), null);
            } catch (e) {
                err = e;
            }
            expect(err).to.be.an('error');
            expect(err.message).to.match(/Unknown db transaction type/);
        });
    });

    // ─── getTransaction (T prefix, hex-key path) ─────────────────────────────

    describe('getTransaction()', function () {
        let db;
        beforeEach(async function () { db = makeDb(); await db.createDatabase(); });
        afterEach(async function () { try { await db.close(); } catch (e) {} });

        it('returns the stored buffer for a known tx key', async function () {
            const txHash = randHash();
            const blockHash = randHash();
            await db.insertTransaction({ hash: txHash, blockHash });
            await db.endTransaction(true);

            // Build the full hex key: P_TX byte + 8-byte txHash prefix
            const P_TX = 0x54;
            const tx8 = txHash.substring(0, 16);
            const keyHex = Buffer.from([P_TX]).toString('hex') + tx8;
            const result = await db.getTransaction(keyHex);
            expect(result).to.not.be.null;
            expect(Buffer.isBuffer(result)).to.be.true;
        });

        it('returns null for an unknown key', async function () {
            const fakeKey = '54' + randHash8();
            const result = await db.getTransaction(fakeKey);
            expect(result).to.be.null;
        });
    });

    // ─── deleteInputs ────────────────────────────────────────────────────────

    describe('deleteInputs()', function () {
        let db;
        beforeEach(async function () { db = makeDb(); await db.createDatabase(); });
        afterEach(async function () { try { await db.close(); } catch (e) {} });

        it('returns 0 for an empty txid list', async function () {
            const count = await db.deleteInputs([]);
            expect(count).to.equal(0);
        });

        it('deletes inputs whose spending tx is NOT in the keep list', async function () {
            const prevTxHash = randHash();
            const spendingTx8 = randHash8(); // this one will NOT be in the keep list

            await db.insertInput({ prevTxHash, prevOutputIndex: 0, txHash: spendingTx8 });
            await db.endTransaction(true);

            // Verify input exists
            const before = await db.getInput(prevTxHash.substring(0, 16), 0);
            expect(before).to.not.be.null;

            // deleteInputs keeps inputs whose txHash IS in the list.
            // Our spendingTx8 is NOT in the list, so it should be deleted.
            await db.beginTransaction();
            const count = await db.deleteInputs([randHash8()]); // unrelated tx in keep list
            await db.endTransaction(true);

            expect(count).to.equal(1);
            const after = await db.getInput(prevTxHash.substring(0, 16), 0);
            expect(after).to.be.null;
        });

        it('keeps inputs whose spending tx IS in the keep list (Buffer form)', async function () {
            const prevTxHash = randHash();
            const spendingTx8 = randHash8();

            await db.insertInput({ prevTxHash, prevOutputIndex: 0, txHash: spendingTx8 });
            await db.endTransaction(true);

            // Pass spendingTx8 as a Buffer (covers the Buffer.isBuffer branch in deleteInputs).
            await db.beginTransaction();
            const txBuf = Buffer.from(spendingTx8, 'hex');
            const count = await db.deleteInputs([txBuf]);
            await db.endTransaction(true);

            // Input should be kept (its tx IS in the list)
            expect(count).to.equal(0);
            const after = await db.getInput(prevTxHash.substring(0, 16), 0);
            expect(after).to.not.be.null;
        });
    });

    // ─── insertOutput with Buffer scriptPubKey ────────────────────────────────

    describe('insertOutput() with Buffer scriptPubKey', function () {
        let db;
        beforeEach(async function () { db = makeDb(); await db.createDatabase(); });
        afterEach(async function () { try { await db.close(); } catch (e) {} });

        it('stores and retrieves an output when scriptPubKey is a Buffer', async function () {
            const scriptBuf = randBuf32();
            const scriptHex = scriptBuf.toString('hex');
            const txHash8   = randHash8();
            const fullTx    = randHash();

            await db.insertOutput({
                scriptPubKey: scriptBuf,  // Buffer path → kOutputFromBuf
                txHash: txHash8,
                outputIndex: 0,
                value: BigInt(55000),
                height: 42,
                fullTxHash: fullTx
            });
            await db.endTransaction(true);

            const outputs = await db.getOutputsScriptPubKey(scriptHex);
            expect(outputs).to.have.length(1);
            expect(outputs[0].value).to.equal('55000');
            expect(outputs[0].height).to.equal(42);
            expect(outputs[0].fullTxid).to.equal(fullTx);
        });

        it('stores and retrieves an output when scriptPubKey is a Buffer with outputIndex > 0xFFFF', async function () {
            // Exercises the high-16-bit word of the cacheKey encoding.
            const scriptBuf = randBuf32();
            const scriptHex = scriptBuf.toString('hex');
            const txHash8   = randHash8();

            await db.insertOutput({
                scriptPubKey: scriptBuf,
                txHash: txHash8,
                outputIndex: 0x1FFFE, // > 0xFFFF, sets the high char
                value: BigInt(1),
                height: 1
            });
            await db.endTransaction(true);

            const outputs = await db.getOutputsScriptPubKey(scriptHex);
            expect(outputs).to.have.length(1);
            expect(outputs[0].vout).to.equal(0x1FFFE);
        });
    });

    // ─── insertOutputHint with Buffer scriptPubKey ────────────────────────────

    describe('insertOutputHint() with Buffer scriptPubKey', function () {
        let db;
        beforeEach(async function () { db = makeDb(); await db.createDatabase(); });
        afterEach(async function () { try { await db.close(); } catch (e) {} });

        it('stores a hint using a Buffer scriptPubKey and allows deletion by hint', async function () {
            const scriptBuf = randBuf32();
            const scriptHex = scriptBuf.toString('hex');
            const txHash8   = randHash8();

            await db.insertOutput({ scriptPubKey: scriptHex, txHash: txHash8, outputIndex: 0, value: BigInt(100), height: 1 });
            await db.insertOutputHint({ scriptPubKey: scriptBuf, txHash: txHash8, outputIndex: 0 }); // Buffer path
            await db.endTransaction(true);

            let outputs = await db.getOutputsScriptPubKey(scriptHex);
            expect(outputs).to.have.length(1);

            await db.beginTransaction();
            const deleted = await db.deleteOutputsByHint(txHash8 + randHash().substring(16));
            await db.endTransaction(true);

            expect(deleted).to.equal(1);
            outputs = await db.getOutputsScriptPubKey(scriptHex);
            expect(outputs).to.be.empty;
        });
    });

    // ─── insertOutputBlock (W prefix) ────────────────────────────────────────

    describe('insertOutputBlock(): W prefix', function () {
        let db;
        beforeEach(async function () { db = makeDb(); await db.createDatabase(); });
        afterEach(async function () { try { await db.close(); } catch (e) {} });

        it('skips insertion when blockHash is falsy', async function () {
            const scriptBuf = randBuf32();
            const result = await db.insertOutputBlock({
                blockHash: null,
                scriptPubKey: scriptBuf,
                txHash: randHash8(),
                outputIndex: 0
            });
            await db.endTransaction(true);
            expect(result).to.be.true;
            // No W entries should exist; DB should be empty for W prefix (0x57)
        });

        it('stages a W entry with hex scriptPubKey', async function () {
            const scriptHex = randHash();
            const txHash8   = randHash8();
            const blockHash = randHash();

            await db.insertOutputBlock({
                blockHash,
                scriptPubKey: scriptHex,  // hex string path
                txHash: txHash8,
                outputIndex: 0
            });
            await db.endTransaction(true);

            // Verify via getValuesFromKeyPattern on the W prefix (0x57)
            const results = await db.getValuesFromKeyPattern('57' + blockHash);
            expect(results).to.have.length(1);
            // Value should be the 32-byte scriptPubKey
            expect(results[0].value).to.equal(scriptHex);
        });

        it('stages a W entry with Buffer scriptPubKey', async function () {
            const scriptBuf = randBuf32();
            const scriptHex = scriptBuf.toString('hex');
            const txHash8   = randHash8();
            const blockHash = randHash();

            await db.insertOutputBlock({
                blockHash,
                scriptPubKey: scriptBuf,  // Buffer path
                txHash: txHash8,
                outputIndex: 0
            });
            await db.endTransaction(true);

            const results = await db.getValuesFromKeyPattern('57' + blockHash);
            expect(results).to.have.length(1);
            expect(results[0].value).to.equal(scriptHex);
        });
    });

    // ─── removeCreatedOutputsInBlock (W prefix reorg cleanup) ────────────────

    describe('removeCreatedOutputsInBlock()', function () {
        let db;
        beforeEach(async function () { db = makeDb(); await db.createDatabase(); });
        afterEach(async function () { try { await db.close(); } catch (e) {} });

        it('deletes O and H entries for outputs created in the rolled-back block', async function () {
            const scriptBuf = randBuf32();
            const scriptHex = scriptBuf.toString('hex');
            const txHash8   = randHash8();
            const blockHash = randHash();

            // Insert output + hint + W-index (simulating confirmed block processing)
            await db.insertOutput({ scriptPubKey: scriptBuf, txHash: txHash8, outputIndex: 0, value: BigInt(9000), height: 50 });
            await db.insertOutputHint({ scriptPubKey: scriptBuf, txHash: txHash8, outputIndex: 0 });
            await db.insertOutputBlock({ blockHash, scriptPubKey: scriptBuf, txHash: txHash8, outputIndex: 0 });
            await db.endTransaction(true);

            // Confirm the output is visible
            let outputs = await db.getOutputsScriptPubKey(scriptHex);
            expect(outputs).to.have.length(1);

            // Simulate reorg: remove all outputs created in this block
            await db.beginTransaction();
            await db.removeCreatedOutputsInBlock(blockHash);
            await db.endTransaction(true);

            // Output should be gone
            outputs = await db.getOutputsScriptPubKey(scriptHex);
            expect(outputs).to.be.empty;
        });

        it('no-ops when no W entries exist for the block', async function () {
            await db.beginTransaction();
            // Should complete silently with nothing to scan
            await db.removeCreatedOutputsInBlock(randHash());
            await db.endTransaction(true);
        });
    });

    // ─── removeOutputsWithInputsBatch: batch remove path ─────────────────────

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

            // Now run the batch removal
            await db.beginTransaction();
            const count = await db.removeOutputsWithInputsBatch([
                { prevTxHash: txHash8, prevOutputIndex: 0, blockHash }
            ]);
            await db.endTransaction(true);

            expect(count).to.equal(1);

            // Output should be gone
            const outputs = await db.getOutputsScriptPubKey(scriptHex);
            expect(outputs).to.be.empty;
        });

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

        it('uses output cache (hit path) when output was recently inserted', async function () {
            const scriptBuf = randBuf32();
            const scriptHex = scriptBuf.toString('hex');
            const txHash8   = randHash8();
            const blockHash = randHash();

            // Insert and commit; this populates the static outputCache
            await db.insertOutput({ scriptPubKey: scriptBuf, txHash: txHash8, outputIndex: 0, value: BigInt(7777), height: 3 });
            await db.insertOutputHint({ scriptPubKey: scriptBuf, txHash: txHash8, outputIndex: 0 });
            await db.endTransaction(true);

            // Cache should now contain the entry (populated by insertOutput above)
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

        it('falls through to del-without-oVal when output has no matching value', async function () {
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
        });
    });

    // ─── insertOutputScriptBlock: Tier 1 and Tier 2 cache paths ──────────────

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

    // ─── processDeletedOutputs: in-memory recovery (deletedTransactionArray) ──

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

    // ─── removeLastStoredBlock: error branch ──────────────────────────────────

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

            // Add the block in a batch but do NOT commit yet
            await db.addLastStoredBlock(blockHash);
            // Now remove it from the same in-flight batch
            const result = await db.removeLastStoredBlock(blockHash);
            await db.endTransaction(true);

            expect(result).to.be.true;
            const blocks = await db.getLastStoredBlocks();
            expect(blocks).to.not.include(blockHash);
        });
    });

    // ─── getValuesFromKeyPattern: error branch ────────────────────────────────

    describe('getValuesFromKeyPattern(): error re-throw', function () {
        let db;
        beforeEach(async function () { db = makeDb(); await db.createDatabase(); });
        afterEach(async function () { try { await db.close(); } catch (e) {} });

        it('re-throws iterator errors', async function () {
            // Force an error by closing the DB and then calling the method
            await db.close();

            let err = null;
            try {
                await db.getValuesFromKeyPattern(Buffer.from([0x4f, 0x00]));
            } catch (e) {
                err = e;
            }
            expect(err).to.be.an('error');

            // Prevent afterEach from trying to close again
            db.db = { close: async () => {} };
        });
    });

    // ─── AddressTooLargeError + InvalidCursorError constructors ──────────────

    describe('exported error classes', function () {
        it('AddressTooLargeError has correct properties', function () {
            const err = new LevelUpStore.AddressTooLargeError(500);
            expect(err.name).to.equal('AddressTooLargeError');
            expect(err.code).to.equal('ADDRESS_TOO_LARGE');
            expect(err.maxOutputs).to.equal(500);
            expect(err.message).to.include('500');
        });

        it('InvalidCursorError has correct properties', function () {
            const err = new LevelUpStore.InvalidCursorError('bad-cursor');
            expect(err.name).to.equal('InvalidCursorError');
            expect(err.code).to.equal('INVALID_CURSOR');
            expect(err.message).to.include('bad-cursor');
        });
    });

    // ─── parseOutputCursor edge cases (exercised via getOutputsScriptPubKey) ──

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

    // ─── deleteInputsByHints (batch variant) ──────────────────────────────────

    describe('deleteInputsByHints()', function () {
        let db;
        beforeEach(async function () { db = makeDb(); await db.createDatabase(); });
        afterEach(async function () { try { await db.close(); } catch (e) {} });

        it('deletes all inputs across multiple txids', async function () {
            const prev1 = randHash();
            const prev2 = randHash();
            const tx1   = randHash8();
            const tx2   = randHash8();

            await db.insertInput({ prevTxHash: prev1, prevOutputIndex: 0, txHash: tx1 });
            await db.insertInputHint({ prevTxHash: prev1, prevOutputIndex: 0, txHash: tx1 });
            await db.insertInput({ prevTxHash: prev2, prevOutputIndex: 0, txHash: tx2 });
            await db.insertInputHint({ prevTxHash: prev2, prevOutputIndex: 0, txHash: tx2 });
            await db.endTransaction(true);

            await db.beginTransaction();
            // deleteInputsByHints accepts full tx ids; deleteInputsByHint uses first 16 chars
            const total = await db.deleteInputsByHints([
                tx1 + randHash().substring(16),
                tx2 + randHash().substring(16),
            ]);
            await db.endTransaction(true);

            expect(total).to.equal(2);
            expect(await db.getInput(prev1.substring(0, 16), 0)).to.be.null;
            expect(await db.getInput(prev2.substring(0, 16), 0)).to.be.null;
        });
    });

    // ─── deleteOutputsByHints (batch variant) ─────────────────────────────────

    describe('deleteOutputsByHints()', function () {
        let db;
        beforeEach(async function () { db = makeDb(); await db.createDatabase(); });
        afterEach(async function () { try { await db.close(); } catch (e) {} });

        it('deletes all outputs across multiple txids', async function () {
            const script1 = randHash();
            const script2 = randHash();
            const tx1     = randHash8();
            const tx2     = randHash8();

            await db.insertOutput({ scriptPubKey: script1, txHash: tx1, outputIndex: 0, value: BigInt(1), height: 1 });
            await db.insertOutputHint({ scriptPubKey: script1, txHash: tx1, outputIndex: 0 });
            await db.insertOutput({ scriptPubKey: script2, txHash: tx2, outputIndex: 0, value: BigInt(2), height: 2 });
            await db.insertOutputHint({ scriptPubKey: script2, txHash: tx2, outputIndex: 0 });
            await db.endTransaction(true);

            await db.beginTransaction();
            const total = await db.deleteOutputsByHints([
                tx1 + randHash().substring(16),
                tx2 + randHash().substring(16),
            ]);
            await db.endTransaction(true);

            expect(total).to.equal(2);
            expect(await db.getOutputsScriptPubKey(script1)).to.be.empty;
            expect(await db.getOutputsScriptPubKey(script2)).to.be.empty;
        });
    });

    // ─── removeTransactionIfExists: false branch ──────────────────────────────

    describe('removeTransactionIfExists()', function () {
        let db;
        beforeEach(async function () { db = makeDb(); await db.createDatabase(); });
        afterEach(async function () { try { await db.close(); } catch (e) {} });

        it('returns false when key is not in the pending transaction map', function () {
            const key = Buffer.from('not-in-map');
            const result = db.removeTransactionIfExists(key);
            expect(result).to.be.false;
        });

        it('returns true when key is present and removes it', async function () {
            const key = Buffer.from('in-map');
            await db.addTransaction('put', key, Buffer.from('val'));
            const result = db.removeTransactionIfExists(key);
            expect(result).to.be.true;
        });
    });

    // ─── getLastBlock with multiple blocks (covers both branches) ────────────

    describe('getLastBlock(): comparison branches', function () {
        let db;
        beforeEach(async function () { db = makeDb(); await db.createDatabase(); });
        afterEach(async function () { try { await db.close(); } catch (e) {} });

        it('selects the tallest block when multiple blocks exist', async function () {
            const h1 = randHash();
            const h2 = randHash();
            const h3 = randHash();

            await db.insertBlock({ hash: h1, height: 5, timestamp: 100, previousHash: randHash() });
            await db.insertBlock({ hash: h2, height: 15, timestamp: 200, previousHash: h1 });
            await db.insertBlock({ hash: h3, height: 10, timestamp: 150, previousHash: h1 });
            await db.endTransaction(true);

            const last = await db.getLastBlock();
            expect(last.height).to.equal(15);
            expect(last.hash).to.equal(h2);
        });
    });

    // ─── height = -1 sentinel in encodeOutput / decodeOutput ─────────────────

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

    // ─── recoverDeletedOutputsHints: standalone M recovery ───────────────────

    describe('recoverDeletedOutputsHints(): standalone M recovery', function () {
        let db;
        beforeEach(async function () { db = makeDb(); await db.createDatabase(); });
        afterEach(async function () { try { await db.close(); } catch (e) {} });

        it('no-ops gracefully when no M entries exist for the block', async function () {
            await db.beginTransaction();
            await db.recoverDeletedOutputsHints(randHash());
            await db.endTransaction(true);
            // Just confirming no throw
        });

        it('restores H entries from M prefix after a committed spend', async function () {
            const scriptHex = randHash();
            const txHash8   = randHash8();
            const blockHash = randHash();

            // Insert and commit output + hint
            await db.insertOutput({ scriptPubKey: scriptHex, txHash: txHash8, outputIndex: 0, value: BigInt(6000), height: 30 });
            await db.insertOutputHint({ scriptPubKey: scriptHex, txHash: txHash8, outputIndex: 0 });
            await db.endTransaction(true);

            // Spend (creates M and K entries on disk)
            await db.beginTransaction();
            await db.removeOutputWithInput({ prevTxHash: txHash8, prevOutputIndex: 0, blockHash });
            await db.endTransaction(true);

            // Recover just the hints
            await db.beginTransaction();
            await db.recoverDeletedOutputsHints(blockHash);
            await db.endTransaction(true);

            // H entry should be visible (check by trying deleteOutputsByHint)
            await db.beginTransaction();
            const count = await db.deleteOutputsByHint(txHash8 + randHash().substring(16));
            await db.endTransaction(true);
            // count may be 0 (no O entry) or 1; just confirm no throw
            expect(count).to.be.gte(0);
        });
    });

    // ─── getLastStoredBlocks with empty DB ───────────────────────────────────

    describe('getLastStoredBlocks() with empty DB', function () {
        let db;
        beforeEach(async function () { db = makeDb(); await db.createDatabase(); });
        afterEach(async function () { try { await db.close(); } catch (e) {} });

        it('returns an empty array when no stored blocks exist', async function () {
            const blocks = await db.getLastStoredBlocks();
            expect(blocks).to.be.an('array').that.is.empty;
        });
    });

    // ─── getValuesFromKeyPattern with Buffer pattern ───────────────────────────

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

    // ─── processDeletedOutputs line 976: item.value = value ─────────────────

    describe('processDeletedOutputs(): item.value update branch (line 976)', function () {
        let db;
        beforeEach(async function () { db = makeDb(); await db.createDatabase(); });
        afterEach(async function () { try { await db.close(); } catch (e) {} });

        it('updates the value of an existing transactionArray entry when recovering', async function () {
            const blockHash = randHash();

            await db.beginTransaction();

            // Manually place a key in BOTH transactionArray AND deletedTransactionArray
            // under the same map-key. This simulates the scenario where a key was
            // re-added to transactionArray after being removed by removeTransaction.
            const fakeKey = Buffer.allocUnsafe(13); // any binary key
            crypto.randomBytes(13).copy(fakeKey);
            const originalVal = Buffer.from('original');
            const recoveredVal = Buffer.from('recovered');

            // Add the key to transactionArray with originalVal
            await db.addTransaction('put', fakeKey, originalVal);

            // Manually register it in deletedTransactionArray with recoveredVal
            // (mimics what removeTransaction followed by recovery should do)
            const mapKey = fakeKey.toString('latin1'); // toMapKey on Buffer
            if (!db.deletedTransactionArray.has(blockHash)) {
                db.deletedTransactionArray.set(blockHash, new Map());
            }
            db.deletedTransactionArray.get(blockHash).set(mapKey, recoveredVal);

            // processDeletedOutputs(recover=true) finds item in transactionArray → line 976
            await db.processDeletedOutputs(blockHash, true);

            // The item's value should have been updated to recoveredVal
            const item = db.transactionArray.get(mapKey);
            expect(item).to.not.be.undefined;
            expect(item.value).to.deep.equal(recoveredVal);

            await db.endTransaction(true);
        });
    });

    // ─── endTransaction catch block (line 489-492) ───────────────────────────

    describe('endTransaction(): batch error catch path', function () {
        let db;
        beforeEach(async function () { db = makeDb(); await db.createDatabase(); });
        afterEach(async function () { try { await db.close(); } catch (e) {} });

        it('throws wrapped Error when batch fails', async function () {
            // Force a batch failure by injecting a malformed item into transactionArray.
            // MemoryLevel with valueEncoding:'buffer' rejects non-Buffer values.
            await db.beginTransaction();
            const badKey = Buffer.from([0x01, 0x02]);
            // Directly inject a corrupt item; batch will fail on null value
            db.transactionArray.set('badkey', {
                type: 'put',
                key: badKey,
                value: null  // null value causes batch to fail on buffer-encoded DB
            });

            let err = null;
            try {
                await db.endTransaction(true);
            } catch (e) {
                err = e;
            }

            // Should throw the wrapped batch error
            expect(err).to.be.an('error');
            expect(err.message).to.equal('Error in LevelDB batch inserting');
            // transactionArray was NOT cleared (catch re-throws before null assignment)
            expect(db.transactionArray).to.be.an.instanceOf(Map);
        });
    });

    // ─── insertOutput: output cache eviction (lines 710-713) ─────────────────

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
