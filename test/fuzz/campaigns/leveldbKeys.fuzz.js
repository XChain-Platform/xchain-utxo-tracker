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
  fc, FUZZ_RUNS, TEST_KEYS,
  arbTxId, arbTxHash8, arbBlockHash, arbSatoshiValue, arbConfirmedHeight,
  randHash, randHash8
} = require('../helpers');
const LevelUpStore = require('../../../src/LevelUpDb');

async function freshDb() {
  const d = new LevelUpStore('fuzz-keys-' + Date.now() + '-' + Math.random(), true);
  await d.createDatabase();
  return d;
}

describe('Fuzz: LevelDB Key Construction (P2)', function () {

  describe('key uniqueness', function () {
    it('outputs with different txHash8 or outputIndex never overwrite each other', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 9 }),
          fc.integer({ min: 2, max: 10 }),
          async (addrIdx, count) => {
            const db = await freshDb();
            try {
              const scriptHash = TEST_KEYS[addrIdx].scriptHash;

              await db.beginTransaction();
              const entries = [];
              for (let i = 0; i < count; i++) {
                const txHash8 = randHash8();
                const fullTxHash = txHash8 + randHash().substring(16);
                const value = BigInt(i + 1) * 1000n;
                await db.insertOutput({
                  scriptPubKey: scriptHash,
                  txHash: txHash8,
                  outputIndex: 0,
                  value,
                  height: i,
                  fullTxHash
                });
                entries.push({ txHash8, value: value.toString() });
              }
              await db.endTransaction(true);

              const outputs = await db.getOutputsScriptPubKey(scriptHash);
              expect(outputs.length).to.equal(count);

              for (const entry of entries) {
                const match = outputs.find(o => o.txid === entry.txHash8);
                expect(match, `No output for txHash8 ${entry.txHash8}`).to.exist;
                expect(match.value).to.equal(entry.value);
              }
            } finally {
              try { await db.close(); } catch (e) {}
            }
          }
        ),
        { numRuns: Math.min(FUZZ_RUNS, 200) }
      );
    });

    it('same txHash8 with different outputIndex produces separate outputs', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 9 }),
          fc.integer({ min: 2, max: 8 }),
          async (addrIdx, outputCount) => {
            const db = await freshDb();
            try {
              const scriptHash = TEST_KEYS[addrIdx].scriptHash;
              const txHash8 = randHash8();
              const fullTxHash = txHash8 + randHash().substring(16);

              await db.beginTransaction();
              for (let i = 0; i < outputCount; i++) {
                await db.insertOutput({
                  scriptPubKey: scriptHash,
                  txHash: txHash8,
                  outputIndex: i,
                  value: BigInt((i + 1) * 1000),
                  height: 100,
                  fullTxHash
                });
              }
              await db.endTransaction(true);

              const outputs = await db.getOutputsScriptPubKey(scriptHash);
              expect(outputs.length).to.equal(outputCount);

              for (let i = 0; i < outputCount; i++) {
                const match = outputs.find(o => o.vout === i);
                expect(match, `Missing output at index ${i}`).to.exist;
                expect(match.value).to.equal(String((i + 1) * 1000));
              }
            } finally {
              try { await db.close(); } catch (e) {}
            }
          }
        ),
        { numRuns: Math.min(FUZZ_RUNS, 200) }
      );
    });

    it('blocks with different hashes are stored independently', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 10 }),
          async (blockCount) => {
            const db = await freshDb();
            try {
              await db.beginTransaction();
              const blocks = [];
              let prevHash = '0'.repeat(64);
              for (let i = 0; i < blockCount; i++) {
                const hash = randHash();
                await db.insertBlock({ hash, height: i, timestamp: 1700000000 + i, previousHash: prevHash });
                blocks.push({ hash, height: i, prevHash });
                prevHash = hash;
              }
              await db.endTransaction(true);

              for (const b of blocks) {
                const block = await db.getBlock(b.hash);
                expect(block).to.exist;
                expect(block.h).to.equal(b.height);
                expect(block.ph).to.equal(b.prevHash);
              }
            } finally {
              try { await db.close(); } catch (e) {}
            }
          }
        ),
        { numRuns: Math.min(FUZZ_RUNS, 200) }
      );
    });

    it('inputs with different prevTxHash or index are stored independently', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 10 }),
          async (count) => {
            const db = await freshDb();
            try {
              await db.beginTransaction();
              const inputs = [];
              for (let i = 0; i < count; i++) {
                const prevTxHash = randHash8();
                const txHash = randHash8();
                await db.insertInput({ prevTxHash, prevOutputIndex: i, txHash });
                inputs.push({ prevTxHash, idx: i, txHash });
              }
              await db.endTransaction(true);

              for (const inp of inputs) {
                // getInput returns raw I-value Buffer [txHash8(8)]
                const result = await db.getInput(inp.prevTxHash, inp.idx);
                expect(result).to.not.be.null;
                expect(Buffer.isBuffer(result)).to.be.true;
                expect(result.toString('hex').substring(0, 16)).to.equal(inp.txHash);
              }
            } finally {
              try { await db.close(); } catch (e) {}
            }
          }
        ),
        { numRuns: Math.min(FUZZ_RUNS, 200) }
      );
    });
  });

  describe('boundary output index values', function () {
    it('output index 0 and max uint32 are both stored correctly', async function () {
      const db = await freshDb();
      try {
        const scriptHash = TEST_KEYS[0].scriptHash;
        const indices = [0, 1, 255, 65535, 4294967294];

        await db.beginTransaction();
        for (const idx of indices) {
          const txHash8 = randHash8();
          const fullTxHash = txHash8 + randHash().substring(16);
          await db.insertOutput({
            scriptPubKey: scriptHash,
            txHash: txHash8,
            outputIndex: idx,
            value: BigInt(idx + 1),
            height: 100,
            fullTxHash
          });
        }
        await db.endTransaction(true);

        const outputs = await db.getOutputsScriptPubKey(scriptHash);
        expect(outputs.length).to.equal(indices.length);
      } finally {
        try { await db.close(); } catch (e) {}
      }
    });
  });

  describe('transaction batching', function () {
    it('large batch of operations commits atomically', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 10, max: 100 }),
          async (batchSize) => {
            const db = await freshDb();
            try {
              const scriptHash = TEST_KEYS[0].scriptHash;

              await db.beginTransaction();
              for (let i = 0; i < batchSize; i++) {
                const txHash8 = randHash8();
                const fullTxHash = txHash8 + randHash().substring(16);
                await db.insertOutput({
                  scriptPubKey: scriptHash,
                  txHash: txHash8,
                  outputIndex: 0,
                  value: BigInt(i + 1),
                  height: i,
                  fullTxHash
                });
              }
              await db.endTransaction(true);

              const outputs = await db.getOutputsScriptPubKey(scriptHash);
              expect(outputs.length).to.equal(batchSize);
            } finally {
              try { await db.close(); } catch (e) {}
            }
          }
        ),
        { numRuns: Math.min(FUZZ_RUNS, 50) }
      );
    });
  });

  describe('missing entries', function () {
    it('getInput returns null for non-existent prevTxHash/index', async function () {
      const db = await freshDb();
      try {
        await fc.assert(
          fc.asyncProperty(
            arbTxHash8(),
            fc.integer({ min: 0, max: 1000 }),
            async (prevTxHash, idx) => {
              const result = await db.getInput(prevTxHash, idx);
              expect(result).to.be.null;
            }
          ),
          { numRuns: FUZZ_RUNS }
        );
      } finally {
        try { await db.close(); } catch (e) {}
      }
    });

    it('getBlock returns null for non-existent hash', async function () {
      const db = await freshDb();
      try {
        await fc.assert(
          fc.asyncProperty(
            arbBlockHash(),
            async (hash) => {
              const result = await db.getBlock(hash);
              expect(result).to.be.null;
            }
          ),
          { numRuns: FUZZ_RUNS }
        );
      } finally {
        try { await db.close(); } catch (e) {}
      }
    });
  });
});
