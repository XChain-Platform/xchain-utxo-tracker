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

const { expect } = require('chai');
const {
  fc, FUZZ_RUNS, arbTxId, arbTxHash8, arbBlockHash, arbSatoshiValue,
  arbSatoshiValueExtreme, arbConfirmedHeight, arbHeight, arbHexString,
  createTestTracker, closeTracker, TEST_KEYS, randHash, randHash8
} = require('../helpers');
const LevelUpStore = require('../../../src/LevelUpDb');

describe('Fuzz: Output Encoding / LevelDB Round-Trip (P0)', function () {
  let db;

  beforeEach(async function () {
    db = new LevelUpStore('fuzz-enc-' + Date.now() + '-' + Math.random(), true);
    await db.createDatabase();
  });

  afterEach(async function () {
    try { await db.close(); } catch (e) {}
  });

  // ─── Output insert/retrieve round-trip ─────────────────────────────────────

  describe('output round-trip', function () {
    it('any value in valid range round-trips through insertOutput/getOutputsScriptPubKey', async function () {
      await fc.assert(
        fc.asyncProperty(
          arbSatoshiValue(),
          arbConfirmedHeight(),
          arbTxId(),
          fc.integer({ min: 0, max: 9 }),
          fc.integer({ min: 0, max: 100 }),
          async (value, height, fullTxHash, addrIdx, outputIndex) => {
            const scriptHash = TEST_KEYS[addrIdx].scriptHash;
            const txHash8 = fullTxHash.substring(0, 16);

            await db.beginTransaction();
            await db.insertOutput({
              scriptPubKey: scriptHash,
              txHash: txHash8,
              outputIndex,
              value,
              height,
              fullTxHash
            });
            await db.endTransaction(true);

            const outputs = await db.getOutputsScriptPubKey(scriptHash);
            expect(outputs.length).to.be.greaterThanOrEqual(1);

            const match = outputs.find(o => o.txid === txHash8 && o.vout === outputIndex);
            expect(match).to.exist;
            expect(match.value).to.equal(value.toString());
            expect(match.height).to.equal(height);
            expect(match.fullTxid).to.equal(fullTxHash);
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });

    it('mempool height (-1) round-trips correctly', async function () {
      await fc.assert(
        fc.asyncProperty(
          arbSatoshiValue(),
          arbTxId(),
          fc.integer({ min: 0, max: 9 }),
          async (value, fullTxHash, addrIdx) => {
            const scriptHash = TEST_KEYS[addrIdx].scriptHash;
            const txHash8 = fullTxHash.substring(0, 16);

            await db.beginTransaction();
            await db.insertOutput({
              scriptPubKey: scriptHash,
              txHash: txHash8,
              outputIndex: 0,
              value,
              height: -1,
              fullTxHash
            });
            await db.endTransaction(true);

            const outputs = await db.getOutputsScriptPubKey(scriptHash);
            const match = outputs.find(o => o.txid === txHash8);
            expect(match).to.exist;
            expect(match.height).to.equal(-1);
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });

    it('extreme satoshi values (uint64 boundary) round-trip correctly', async function () {
      await fc.assert(
        fc.asyncProperty(
          arbSatoshiValueExtreme(),
          arbTxId(),
          async (value, fullTxHash) => {
            const scriptHash = TEST_KEYS[0].scriptHash;
            const txHash8 = fullTxHash.substring(0, 16);

            await db.beginTransaction();
            await db.insertOutput({
              scriptPubKey: scriptHash,
              txHash: txHash8,
              outputIndex: 0,
              value,
              height: 100,
              fullTxHash
            });
            await db.endTransaction(true);

            const outputs = await db.getOutputsScriptPubKey(scriptHash);
            const match = outputs.find(o => o.txid === txHash8);
            expect(match).to.exist;
            expect(match.value).to.equal(value.toString());
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });

    it('zero-value output round-trips correctly', async function () {
      const scriptHash = TEST_KEYS[0].scriptHash;
      const txHash8 = randHash8();
      const fullTxHash = txHash8 + randHash().substring(16);

      await db.beginTransaction();
      await db.insertOutput({
        scriptPubKey: scriptHash,
        txHash: txHash8,
        outputIndex: 0,
        value: 0n,
        height: 50,
        fullTxHash
      });
      await db.endTransaction(true);

      const outputs = await db.getOutputsScriptPubKey(scriptHash);
      const match = outputs.find(o => o.txid === txHash8);
      expect(match).to.exist;
      expect(match.value).to.equal('0');
    });
  });

  // ─── Block insert/retrieve round-trip ──────────────────────────────────────

  describe('block round-trip', function () {
    it('block data round-trips for any valid height/timestamp/hash', async function () {
      await fc.assert(
        fc.asyncProperty(
          arbBlockHash(),
          fc.integer({ min: 0, max: 4294967295 }),
          fc.integer({ min: 0, max: 4294967295 }),
          arbBlockHash(),
          async (hash, height, timestamp, previousHash) => {
            await db.beginTransaction();
            await db.insertBlock({ hash, height, timestamp, previousHash });
            await db.endTransaction(true);

            const block = await db.getBlock(hash);
            expect(block).to.exist;
            expect(block.h).to.equal(height);
            expect(block.t).to.equal(timestamp);
            expect(block.ph).to.equal(previousHash);
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });
  });

  // ─── Multiple outputs per script ───────────────────────────────────────────

  describe('multiple outputs per script', function () {
    it('multiple outputs for same scriptHash are all retrievable', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 9 }),
          fc.integer({ min: 2, max: 10 }),
          async (addrIdx, count) => {
            // Fresh DB per property run to avoid accumulation
            const freshDb = new LevelUpStore('fuzz-multi-' + Date.now() + '-' + Math.random(), true);
            await freshDb.createDatabase();
            try {
              const scriptHash = TEST_KEYS[addrIdx].scriptHash;

              await freshDb.beginTransaction();
              const expected = [];
              for (let i = 0; i < count; i++) {
                const txHash8 = randHash8();
                const fullTxHash = txHash8 + randHash().substring(16);
                const value = BigInt(Math.floor(Math.random() * 1000000));
                await freshDb.insertOutput({
                  scriptPubKey: scriptHash,
                  txHash: txHash8,
                  outputIndex: 0,
                  value,
                  height: i,
                  fullTxHash
                });
                expected.push({ txid: txHash8, value: value.toString() });
              }
              await freshDb.endTransaction(true);

              const outputs = await freshDb.getOutputsScriptPubKey(scriptHash);
              expect(outputs.length).to.equal(count);

              for (const exp of expected) {
                const match = outputs.find(o => o.txid === exp.txid);
                expect(match, `Missing output for txid ${exp.txid}`).to.exist;
                expect(match.value).to.equal(exp.value);
              }
            } finally {
              try { await freshDb.close(); } catch (e) {}
            }
          }
        ),
        { numRuns: Math.min(FUZZ_RUNS, 200) }
      );
    });
  });

  // ─── Block height/hash storage ─────────────────────────────────────────────

  describe('block height and hash storage', function () {
    it('block height round-trips for any non-negative integer', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 4294967295 }),
          async (height) => {
            await db.beginTransaction();
            await db.setLastBlockHeight(height);
            await db.endTransaction(true);
            const retrieved = await db.getLastBlockHeight();
            expect(retrieved).to.equal(height);
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });

    it('block hash round-trips for any 64-char hex', async function () {
      await fc.assert(
        fc.asyncProperty(
          arbBlockHash(),
          async (hash) => {
            await db.beginTransaction();
            await db.setLastBlockHash(hash);
            await db.endTransaction(true);
            const retrieved = await db.getLastBlockHash();
            expect(retrieved).to.equal(hash);
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });
  });

  // ─── Input insert/retrieve ─────────────────────────────────────────────────

  describe('input round-trip', function () {
    it('input data round-trips through insertInput/getInput', async function () {
      await fc.assert(
        fc.asyncProperty(
          arbTxHash8(),
          fc.integer({ min: 0, max: 1000 }),
          arbTxHash8(),
          async (prevTxHash, prevOutputIndex, txHash) => {
            await db.beginTransaction();
            await db.insertInput({ prevTxHash, prevOutputIndex, txHash });
            await db.endTransaction(true);

            // getInput returns raw Buffer (I value = [txHash8(8)])
            const input = await db.getInput(prevTxHash, prevOutputIndex);
            expect(input).to.not.be.null;
            expect(Buffer.isBuffer(input)).to.be.true;
            expect(input.toString('hex').substring(0, 16)).to.equal(txHash);
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });
  });
});
