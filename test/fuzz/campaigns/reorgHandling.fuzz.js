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
const sinon = require('sinon');
const {
  fc, FUZZ_RUNS, TEST_KEYS, SATOSHI,
  createTestTracker, closeTracker, randHash,
  makeTx, makeCoinbaseTx, makeCoinbaseInput, makeSpendInput, makeBlock,
  processAndCommit, processBlocksAndCommit, buildCoinbaseChain
} = require('../helpers');
const { satoshiToDecimalString } = require('../../../src/XChainUtxoTracker');

describe('Fuzz: Reorg Handling (P1)', function () {

  // This matches the production flow: verifyReorg() compares DB state with node,
  // rolls back mismatched blocks, then the main loop re-processes from fork point.
  async function setupAndRunReorg(tracker, originalBlocks, forkBlocks) {
    const forkHeight = forkBlocks[0].height;
    const nodeHashes = {};

    for (let i = 0; i < forkHeight; i++) {
      nodeHashes[i] = originalBlocks[i].hash;
    }
    for (const fb of forkBlocks) {
      nodeHashes[fb.height] = fb.hash;
    }

    sinon.stub(tracker.connector, 'getBlockHash').callsFake(async (height) => {
      if (height in nodeHashes) return nodeHashes[height];
      throw new Error('Block height out of range: ' + height);
    });

    // verifyReorg runs with transactionArray=null (direct writes)
    if (tracker.db.transactionArray) {
      await tracker.db.endTransaction(false);
    }
    tracker.db.transactionArray = null;
    tracker.db.deletedTransactionArray = null;

    await tracker.verifyReorg();

    sinon.restore();

    for (const block of forkBlocks) {
      await processAndCommit(tracker, block);
    }
  }

  describe('reorg height/hash rollback', function () {
    it('rolls back to correct fork point', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 3, max: 8 }),
          fc.integer({ min: 1, max: 3 }),
          async (chainLen, reorgDepth) => {
            const depth = Math.min(reorgDepth, chainLen - 1);
            if (depth < 1) return;

            const t = await createTestTracker();
            try {
              const originalBlocks = [];
              let prevHash = '0'.repeat(64);
              for (let i = 0; i < chainLen; i++) {
                const block = makeBlock(i, prevHash, [makeCoinbaseTx(0)]);
                originalBlocks.push(block);
                prevHash = block.hash;
              }
              for (const block of originalBlocks) {
                await processAndCommit(t, block);
              }

              expect(await t.db.getLastBlockHeight()).to.equal(chainLen - 1);

              const forkStart = chainLen - depth;
              const forkBlocks = [];
              prevHash = originalBlocks[forkStart - 1].hash;
              for (let i = forkStart; i < chainLen; i++) {
                const block = makeBlock(i, prevHash, [makeCoinbaseTx(1)]);
                forkBlocks.push(block);
                prevHash = block.hash;
              }

              await setupAndRunReorg(t, originalBlocks, forkBlocks);

              expect(await t.db.getLastBlockHeight()).to.equal(chainLen - 1);

              for (let i = forkStart; i < chainLen; i++) {
                expect(await t.db.getBlock(originalBlocks[i].hash)).to.be.null;
              }

              for (const fb of forkBlocks) {
                const b = await t.db.getBlock(fb.hash);
                expect(b).to.not.be.null;
                expect(b.h).to.equal(fb.height);
              }
            } finally {
              sinon.restore();
              await closeTracker(t);
            }
          }
        ),
        { numRuns: Math.min(FUZZ_RUNS, 30) }
      );
    });
  });

  describe('spent output recovery after reorg', function () {
    it('spent output is recovered when the spending block is reorged away', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.bigInt({ min: 10000n, max: 10000000000n }),
          fc.integer({ min: 0, max: 4 }),
          async (value, addrIdx) => {
            const t = await createTestTracker();
            try {
              const otherIdx = (addrIdx + 1) % 10;

              const coinbaseTx = makeTx({
                ins: [makeCoinbaseInput()],
                outs: [{ value, script: TEST_KEYS[addrIdx].script }]
              });
              const block0 = makeBlock(0, '0'.repeat(64), [coinbaseTx]);
              await processAndCommit(t, block0);

              const spendTx = makeTx({
                ins: [makeSpendInput(coinbaseTx._txid, 0)],
                outs: [{ value, script: TEST_KEYS[otherIdx].script }]
              });
              const block1 = makeBlock(1, block0.hash, [makeCoinbaseTx((addrIdx + 2) % 10), spendTx]);
              await processAndCommit(t, block1);

              let info = await t.getBalanceInfo(TEST_KEYS[addrIdx].address);
              expect(info.balances.confirmed).to.equal('0.00000000');

              const altBlock1 = makeBlock(1, block0.hash, [makeCoinbaseTx((addrIdx + 3) % 10)]);
              await setupAndRunReorg(t, [block0, block1], [altBlock1]);

              // Recovered from the K/M deleted-output archive that verifyReorg
              // restores when the spending block is rolled back.
              info = await t.getBalanceInfo(TEST_KEYS[addrIdx].address);
              expect(info.balances.confirmed).to.equal(satoshiToDecimalString(value));
            } finally {
              sinon.restore();
              await closeTracker(t);
            }
          }
        ),
        { numRuns: Math.min(FUZZ_RUNS, 30) }
      );
    });
  });

  describe('pre-fork block preservation', function () {
    it('blocks before the fork point are preserved after reorg', async function () {
      const t = await createTestTracker();
      try {
        const blocks = [];
        let prevHash = '0'.repeat(64);
        for (let i = 0; i < 5; i++) {
          const block = makeBlock(i, prevHash, [makeCoinbaseTx(0)]);
          blocks.push(block);
          prevHash = block.hash;
        }
        for (const block of blocks) {
          await processAndCommit(t, block);
        }

        const forkBlocks = [];
        prevHash = blocks[2].hash;
        for (let i = 3; i < 5; i++) {
          const block = makeBlock(i, prevHash, [makeCoinbaseTx(1)]);
          forkBlocks.push(block);
          prevHash = block.hash;
        }

        await setupAndRunReorg(t, blocks, forkBlocks);

        for (let i = 0; i <= 2; i++) {
          const b = await t.db.getBlock(blocks[i].hash);
          expect(b).to.not.be.null;
          expect(b.h).to.equal(i);
        }
      } finally {
        sinon.restore();
        await closeTracker(t);
      }
    });
  });
});
