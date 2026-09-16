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
const LevelUpStore = require('../../src/store/level_up_db');

function randHash() { return crypto.randomBytes(32).toString('hex'); }
function randHash8() { return crypto.randomBytes(8).toString('hex'); }
function randBuf32() { return crypto.randomBytes(32); }

let dbCounter = 0;
function makeDb() {
    return new LevelUpStore('more-test-' + Date.now() + '-' + (++dbCounter), true);
}

describe('LevelUpDb (extended coverage)', function () {
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
});

describe('LevelUpDb (extended coverage)', function () {
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
});

describe('LevelUpDb (extended coverage)', function () {
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
});

describe('LevelUpDb (extended coverage)', function () {
    // deleteInputs() removed 2026-07-10: dead code with zero src/ callers,
    // a byte-for-byte second implementation of the I-key scan pattern used
    // elsewhere. See uuid:340641ec.

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
});

describe('LevelUpDb (extended coverage)', function () {
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
});

describe('LevelUpDb (extended coverage)', function () {
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
});

describe('LevelUpDb (extended coverage)', function () {
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

            let outputs = await db.getOutputsScriptPubKey(scriptHex);
            expect(outputs).to.have.length(1);

            // Simulate reorg: remove all outputs created in this block
            await db.beginTransaction();
            await db.removeCreatedOutputsInBlock(blockHash);
            await db.endTransaction(true);

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
});

describe('LevelUpDb (extended coverage)', function () {
    describe('removeCreatedOutputsBlockIndexOnly()', function () {
        let db;
        beforeEach(async function () { db = makeDb(); await db.createDatabase(); });
        afterEach(async function () { try { await db.close(); } catch (e) {} });

        it('deletes the W reverse-index for the block but LEAVES the live O/H output', async function () {
            const scriptBuf = randBuf32();
            const scriptHex = scriptBuf.toString('hex');
            const txHash8   = randHash8();
            const blockHash = randHash();

            await db.insertOutput({ scriptPubKey: scriptBuf, txHash: txHash8, outputIndex: 0, value: BigInt(9000), height: 50 });
            await db.insertOutputHint({ scriptPubKey: scriptBuf, txHash: txHash8, outputIndex: 0 });
            await db.insertOutputBlock({ blockHash, scriptPubKey: scriptBuf, txHash: txHash8, outputIndex: 0 });
            await db.endTransaction(true);

            // W entry present, output visible
            expect(await db.getValuesFromKeyPattern('57' + blockHash)).to.have.length(1);
            expect(await db.getOutputsScriptPubKey(scriptHex)).to.have.length(1);

            // Aged-out prune: drop only the W index for this block
            await db.beginTransaction();
            await db.removeCreatedOutputsBlockIndexOnly(blockHash);
            await db.endTransaction(true);

            // W gone; the live output (O/H) must still be there (unlike the reorg path)
            expect(await db.getValuesFromKeyPattern('57' + blockHash)).to.be.empty;
            expect(await db.getOutputsScriptPubKey(scriptHex)).to.have.length(1);
        });

        it('no-ops when no W entries exist for the block', async function () {
            await db.beginTransaction();
            await db.removeCreatedOutputsBlockIndexOnly(randHash());
            await db.endTransaction(true);
        });
    });
});
