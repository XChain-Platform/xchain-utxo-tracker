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
  SATOSHI, TEST_KEYS, randHash,
  makeOutput, makeSpendInput, makeTx, makeCoinbaseTx,
  makeBlock, buildCoinbaseChain,
  stubBlockchain, addBlockToState,
  sleep, waitForHeight, waitForSynced,
  createE2ETracker, patchLevelUpStoreInMemory
} = require('./helpers');

// Poll until predicate() resolves truthy. waitForHeight only waits for the height to
// climb (h >= target); a rollback moves the committed height/hash backward or sideways,
// so the regression drills below need a predicate that can observe that.
async function waitForCondition(predicate, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await predicate()) return true; } catch (e) { /* db not ready yet */ }
    await sleep(100);
  }
  throw new Error('Timed out waiting for condition');
}

describe('E2E: Chain Reorganization via start() Loop', function () {
  let tracker;
  let restoreLevelUp;

  beforeEach(function () {
    restoreLevelUp = patchLevelUpStoreInMemory();
    tracker = createE2ETracker();
  });

  afterEach(async function () {
    sinon.restore();
    await tracker.stopParsing();
    restoreLevelUp();
  });

  /**
   * Reorg detection in the start() loop:
   * When fetching block at height N+1, if block.prevHash != lastProcessedBlockHash,
   * verifyReorg() is called. It compares stored block hashes against the node's
   * getBlockHash() responses, rolling back mismatched blocks.
   *
   * To trigger: replace blocks in state AND add a new tip block linking to
   * the replacement chain (so the tracker fetches a block whose prevHash mismatches).
   */

  describe('D1: reorg detection and recovery', function () {
    it('detects reorg, rolls back, and re-syncs to the new chain', async function () {
      const blocks = buildCoinbaseChain(5, 0);
      const state = stubBlockchain(tracker, blocks);

      tracker.start();
      await waitForSynced(tracker);

      expect(await tracker.db.getLastBlockHeight()).to.equal(4);

      const replacementBlock4 = makeBlock(4, blocks[3].hash, [makeCoinbaseTx(1, 50 * SATOSHI)]);
      state.hashToBlock.delete(blocks[4].hash);
      state.blocks[4] = replacementBlock4;
      state.hashToBlock.set(replacementBlock4.hash, replacementBlock4);

      const block5 = makeBlock(5, replacementBlock4.hash, [makeCoinbaseTx(1, 50 * SATOSHI)]);
      addBlockToState(state, block5);

      await waitForHeight(tracker, 5, 30000);
      await waitForSynced(tracker, 10000);

      expect(await tracker.db.getLastBlockHeight()).to.equal(5);
      expect(await tracker.db.getLastBlockHash()).to.equal(block5.hash);

      const b5 = await tracker.db.getBlock(block5.hash);
      expect(b5).to.not.be.null;
      expect(b5.h).to.equal(5);

      const b4 = await tracker.db.getBlock(replacementBlock4.hash);
      expect(b4).to.not.be.null;
      expect(b4.h).to.equal(4);

      const oldB4 = await tracker.db.getBlock(blocks[4].hash);
      expect(oldB4).to.be.null;

      const info1 = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(info1.balances.confirmed).to.equal('100.00000000'); // blocks 4+5
      expect(info1.utxos.confirmed).to.equal(2);
    });
  });

  describe('D2: multi-block reorg (3 blocks replaced)', function () {
    it('rolls back multiple blocks and indexes the replacement chain', async function () {
      const blocks = buildCoinbaseChain(8, 0, 0, 10 * SATOSHI);
      const state = stubBlockchain(tracker, blocks);

      tracker.start();
      await waitForSynced(tracker);

      expect(await tracker.db.getLastBlockHeight()).to.equal(7);

      const newBlock5 = makeBlock(5, blocks[4].hash, [makeCoinbaseTx(1, 10 * SATOSHI)]);
      const newBlock6 = makeBlock(6, newBlock5.hash, [makeCoinbaseTx(1, 10 * SATOSHI)]);
      const newBlock7 = makeBlock(7, newBlock6.hash, [makeCoinbaseTx(1, 10 * SATOSHI)]);

      for (let i = 5; i <= 7; i++) {
        state.hashToBlock.delete(state.blocks[i].hash);
      }
      state.blocks[5] = newBlock5;
      state.blocks[6] = newBlock6;
      state.blocks[7] = newBlock7;
      state.hashToBlock.set(newBlock5.hash, newBlock5);
      state.hashToBlock.set(newBlock6.hash, newBlock6);
      state.hashToBlock.set(newBlock7.hash, newBlock7);

      const newBlock8 = makeBlock(8, newBlock7.hash, [makeCoinbaseTx(1, 10 * SATOSHI)]);
      addBlockToState(state, newBlock8);

      await waitForHeight(tracker, 8, 30000);
      await waitForSynced(tracker, 10000);

      expect(await tracker.db.getLastBlockHeight()).to.equal(8);
      expect(await tracker.db.getLastBlockHash()).to.equal(newBlock8.hash);

      for (let i = 5; i <= 7; i++) {
        const b = await tracker.db.getBlock(blocks[i].hash);
        expect(b, `old block ${i}`).to.be.null;
      }

      expect(await tracker.db.getBlock(newBlock5.hash)).to.not.be.null;
      expect(await tracker.db.getBlock(newBlock6.hash)).to.not.be.null;
      expect(await tracker.db.getBlock(newBlock7.hash)).to.not.be.null;
      expect(await tracker.db.getBlock(newBlock8.hash)).to.not.be.null;

      const info1 = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(info1.balances.confirmed).to.equal('40.00000000'); // 4 replacement blocks (5-8) x 10 BTC
      expect(info1.utxos.confirmed).to.equal(4);

      for (let i = 0; i <= 4; i++) {
        const b = await tracker.db.getBlock(blocks[i].hash);
        expect(b, `block ${i}`).to.not.be.null;
        expect(b.h).to.equal(i);
      }
    });
  });

  describe('D3: reorg followed by continued indexing', function () {
    it('resumes normal indexing after a reorg', async function () {
      const blocks = buildCoinbaseChain(5, 0);
      const state = stubBlockchain(tracker, blocks);

      tracker.start();
      await waitForSynced(tracker);

      const replacement4 = makeBlock(4, blocks[3].hash, [makeCoinbaseTx(1, 25 * SATOSHI)]);
      state.hashToBlock.delete(blocks[4].hash);
      state.blocks[4] = replacement4;
      state.hashToBlock.set(replacement4.hash, replacement4);

      const block5 = makeBlock(5, replacement4.hash, [makeCoinbaseTx(1, 30 * SATOSHI)]);
      addBlockToState(state, block5);

      await waitForHeight(tracker, 5, 30000);

      const info1 = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(info1.balances.confirmed).to.equal('55.00000000'); // 25 + 30

      const block6 = makeBlock(6, block5.hash, [makeCoinbaseTx(2, 15 * SATOSHI)]);
      addBlockToState(state, block6);

      await waitForHeight(tracker, 6, 15000);

      const info2 = await tracker.getBalanceInfo(TEST_KEYS[2].address);
      expect(info2.balances.confirmed).to.equal('15.00000000');
    });
  });

  describe('D4: reorg detection mechanism validation', function () {
    it('triggers verifyReorg when new block prevHash does not match', async function () {
      const blocks = buildCoinbaseChain(3, 0);
      const state = stubBlockchain(tracker, blocks);

      tracker.start();
      await waitForSynced(tracker);

      const heightBefore = await tracker.db.getLastBlockHeight();
      expect(heightBefore).to.equal(2);

      const reorgSpy = sinon.spy(tracker, 'verifyReorg');

      const replacement2 = makeBlock(2, blocks[1].hash, [makeCoinbaseTx(1, 20 * SATOSHI)]);
      state.hashToBlock.delete(blocks[2].hash);
      state.blocks[2] = replacement2;
      state.hashToBlock.set(replacement2.hash, replacement2);

      const block3 = makeBlock(3, replacement2.hash, [makeCoinbaseTx(1, 30 * SATOSHI)]);
      addBlockToState(state, block3);

      await waitForHeight(tracker, 3, 30000);

      expect(reorgSpy.called).to.be.true;
      expect(await tracker.db.getLastBlockHeight()).to.equal(3);
    });
  });

  // Drill for the verifyReorg(nodeTip) path. When the node's tip drops below our
  // committed tip, the pre-fix loop warned then spun forever fetching a block the node
  // no longer had, while still serving the orphaned tip's UTXOs.

  describe('D5: node-tip regression below the committed tip', function () {
    it('rolls back to the node tip instead of spinning on a vanished block', async function () {
      // Heights 0-2 pay addr 0; heights 3-5 pay addr 1. A rollback to height 2 must
      // therefore drop addr 1 entirely.
      const all = buildCoinbaseChain(3, 0); // 0,1,2 -> addr 0
      for (let h = 3; h <= 5; h++) {
        all.push(makeBlock(h, all[h - 1].hash, [makeCoinbaseTx(1, 50 * SATOSHI)]));
      }
      const state = stubBlockchain(tracker, all);

      tracker.start();
      await waitForSynced(tracker);
      expect(await tracker.db.getLastBlockHeight()).to.equal(5);

      const reorgSpy = sinon.spy(tracker, 'verifyReorg');

      // Node resets / reindexes: its chain now ends at height 2. getBlockchainInfo reports
      // tip 2 and getBlockHash(3..5) throws, exactly as a reset node would. Heights 0-2
      // keep their original hashes (the common ancestor).
      for (let h = 3; h <= 5; h++) state.hashToBlock.delete(all[h].hash);
      state.blocks.length = 3;

      // The tracker must roll back to the node tip and settle there (not climb past it).
      await waitForCondition(async () =>
        (await tracker.db.getLastBlockHeight()) === 2 &&
        (await tracker.db.getLastBlockHash()) === all[2].hash);

      expect(await tracker.db.getLastBlockHeight()).to.equal(2);
      expect(await tracker.db.getLastBlockHash()).to.equal(all[2].hash);

      // verifyReorg was driven with the node tip height (the regression path).
      expect(reorgSpy.called).to.be.true;
      expect(reorgSpy.firstCall.args[0]).to.equal(2);

      for (let h = 3; h <= 5; h++) {
        expect(await tracker.db.getBlock(all[h].hash), `orphaned block ${h}`).to.be.null;
      }
      const info1 = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(info1.balances.confirmed).to.equal('0.00000000');
      expect(info1.utxos.confirmed).to.equal(0);

      for (let h = 0; h <= 2; h++) {
        expect(await tracker.db.getBlock(all[h].hash), `block ${h}`).to.not.be.null;
      }
      expect(tracker.synced).to.be.true;
    });
  });

  // Drill for the synced same-height re-check. The node swaps its tip block at the SAME
  // height and stalls; the pre-fix tracker kept serving the orphaned block's UTXOs until
  // a new height arrived.

  describe('D6: same-height tip reorg while synced', function () {
    it('re-checks the committed tip hash and rolls onto the replacement tip', async function () {
      const blocks = buildCoinbaseChain(5, 0); // 0-4 -> addr 0
      const state = stubBlockchain(tracker, blocks);

      tracker.start();
      await waitForSynced(tracker);
      expect(await tracker.db.getLastBlockHeight()).to.equal(4);
      expect(await tracker.db.getLastBlockHash()).to.equal(blocks[4].hash);

      const reorgSpy = sinon.spy(tracker, 'verifyReorg');

      // A competing block wins height 4 (coinbase now pays addr 1); the node stays at
      // height 4 with no new block ever added.
      const replacement4 = makeBlock(4, blocks[3].hash, [makeCoinbaseTx(1, 50 * SATOSHI)]);
      state.hashToBlock.delete(blocks[4].hash);
      state.blocks[4] = replacement4;
      state.hashToBlock.set(replacement4.hash, replacement4);

      // The synced re-check must notice the same-height swap and roll onto the new tip.
      await waitForCondition(async () =>
        (await tracker.db.getLastBlockHash()) === replacement4.hash);

      expect(await tracker.db.getLastBlockHeight()).to.equal(4);
      expect(await tracker.db.getLastBlockHash()).to.equal(replacement4.hash);

      // The same-height path drives verifyReorg() with no node-tip argument.
      expect(reorgSpy.called).to.be.true;
      expect(reorgSpy.firstCall.args[0]).to.equal(undefined);

      expect(await tracker.db.getBlock(blocks[4].hash)).to.be.null;
      expect(await tracker.db.getBlock(replacement4.hash)).to.not.be.null;
      const info1 = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(info1.balances.confirmed).to.equal('50.00000000');
      expect(info1.utxos.confirmed).to.equal(1);
    });
  });
});
