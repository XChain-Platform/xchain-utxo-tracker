'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
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

  // ─── E2E-D1: Reorg Detection and Recovery ─────────────────────────────

  describe('D1: reorg detection and recovery', function () {
    it('detects reorg, rolls back, and re-syncs to the new chain', async function () {
      // Build 5 blocks (0-4), all coinbase to addr 0
      const blocks = buildCoinbaseChain(5, 0);
      const state = stubBlockchain(tracker, blocks);

      tracker.start();
      await waitForSynced(tracker);

      expect(await tracker.db.getLastBlockHeight()).to.equal(4);

      // Replace block 4 with a different block to addr 1
      const replacementBlock4 = makeBlock(4, blocks[3].hash, [makeCoinbaseTx(1, 50 * SATOSHI)]);
      state.hashToBlock.delete(blocks[4].hash);
      state.blocks[4] = replacementBlock4;
      state.hashToBlock.set(replacementBlock4.hash, replacementBlock4);

      // Add block 5 on the replacement chain to trigger reorg detection
      const block5 = makeBlock(5, replacementBlock4.hash, [makeCoinbaseTx(1, 50 * SATOSHI)]);
      addBlockToState(state, block5);

      // Wait for tracker to detect reorg and re-sync
      await waitForHeight(tracker, 5, 30000);
      await waitForSynced(tracker, 10000);

      // After reorg: tracker is synced at height 5 with the new chain
      expect(await tracker.db.getLastBlockHeight()).to.equal(5);
      expect(await tracker.db.getLastBlockHash()).to.equal(block5.hash);

      // Block 5's B record exists
      const b5 = await tracker.db.getBlock(block5.hash);
      expect(b5).to.not.be.null;
      expect(b5.h).to.equal(5);

      // Replacement block 4's B record exists
      const b4 = await tracker.db.getBlock(replacementBlock4.hash);
      expect(b4).to.not.be.null;
      expect(b4.h).to.equal(4);

      // Old block 4's B record was deleted during reorg
      const oldB4 = await tracker.db.getBlock(blocks[4].hash);
      expect(oldB4).to.be.null;

      // Addr 1 received the replacement chain's coinbases
      const info1 = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(info1.balances.confirmed).to.equal('100.00000000'); // blocks 4+5
      expect(info1.utxos.confirmed).to.equal(2);
    });
  });

  // ─── E2E-D2: Multi-Block Reorg Detection ──────────────────────────────

  describe('D2: multi-block reorg (3 blocks replaced)', function () {
    it('rolls back multiple blocks and indexes the replacement chain', async function () {
      const blocks = buildCoinbaseChain(8, 0, 0, 10 * SATOSHI);
      const state = stubBlockchain(tracker, blocks);

      tracker.start();
      await waitForSynced(tracker);

      expect(await tracker.db.getLastBlockHeight()).to.equal(7);

      // Replace blocks 5, 6, 7 with new blocks to addr 1
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

      // Add block 8 on the replacement chain to trigger reorg detection
      const newBlock8 = makeBlock(8, newBlock7.hash, [makeCoinbaseTx(1, 10 * SATOSHI)]);
      addBlockToState(state, newBlock8);

      await waitForHeight(tracker, 8, 30000);
      await waitForSynced(tracker, 10000);

      // Tracker is synced at height 8 on the new chain
      expect(await tracker.db.getLastBlockHeight()).to.equal(8);
      expect(await tracker.db.getLastBlockHash()).to.equal(newBlock8.hash);

      // Old blocks' B records are deleted
      for (let i = 5; i <= 7; i++) {
        const b = await tracker.db.getBlock(blocks[i].hash);
        expect(b, `old block ${i}`).to.be.null;
      }

      // New blocks' B records exist
      expect(await tracker.db.getBlock(newBlock5.hash)).to.not.be.null;
      expect(await tracker.db.getBlock(newBlock6.hash)).to.not.be.null;
      expect(await tracker.db.getBlock(newBlock7.hash)).to.not.be.null;
      expect(await tracker.db.getBlock(newBlock8.hash)).to.not.be.null;

      // Addr 1 received the replacement chain coinbases (blocks 5-8)
      const info1 = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(info1.balances.confirmed).to.equal('40.00000000');
      expect(info1.utxos.confirmed).to.equal(4);

      // Blocks 0-4 remain intact
      for (let i = 0; i <= 4; i++) {
        const b = await tracker.db.getBlock(blocks[i].hash);
        expect(b, `block ${i}`).to.not.be.null;
        expect(b.h).to.equal(i);
      }
    });
  });

  // ─── E2E-D3: Reorg then Continued Indexing ────────────────────────────

  describe('D3: reorg followed by continued indexing', function () {
    it('resumes normal indexing after a reorg', async function () {
      const blocks = buildCoinbaseChain(5, 0);
      const state = stubBlockchain(tracker, blocks);

      tracker.start();
      await waitForSynced(tracker);

      // Replace block 4 and add blocks 5-6 on replacement chain
      const replacement4 = makeBlock(4, blocks[3].hash, [makeCoinbaseTx(1, 25 * SATOSHI)]);
      state.hashToBlock.delete(blocks[4].hash);
      state.blocks[4] = replacement4;
      state.hashToBlock.set(replacement4.hash, replacement4);

      const block5 = makeBlock(5, replacement4.hash, [makeCoinbaseTx(1, 30 * SATOSHI)]);
      addBlockToState(state, block5);

      await waitForHeight(tracker, 5, 30000);

      // After reorg + re-index, addr 1 has the replacement chain coinbases
      const info1 = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(info1.balances.confirmed).to.equal('55.00000000'); // 25 + 30

      // Can still add more blocks and they index correctly
      const block6 = makeBlock(6, block5.hash, [makeCoinbaseTx(2, 15 * SATOSHI)]);
      addBlockToState(state, block6);

      await waitForHeight(tracker, 6, 15000);

      const info2 = await tracker.getBalanceInfo(TEST_KEYS[2].address);
      expect(info2.balances.confirmed).to.equal('15.00000000');
    });
  });

  // ─── E2E-D4: Reorg Detected via prevHash Mismatch ────────────────────

  describe('D4: reorg detection mechanism validation', function () {
    it('triggers verifyReorg when new block prevHash does not match', async function () {
      const blocks = buildCoinbaseChain(3, 0);
      const state = stubBlockchain(tracker, blocks);

      tracker.start();
      await waitForSynced(tracker);

      const heightBefore = await tracker.db.getLastBlockHeight();
      expect(heightBefore).to.equal(2);

      // Spy on verifyReorg to confirm it was called
      const reorgSpy = sinon.spy(tracker, 'verifyReorg');

      // Replace block 2 and add block 3 with new prevHash
      const replacement2 = makeBlock(2, blocks[1].hash, [makeCoinbaseTx(1, 20 * SATOSHI)]);
      state.hashToBlock.delete(blocks[2].hash);
      state.blocks[2] = replacement2;
      state.hashToBlock.set(replacement2.hash, replacement2);

      const block3 = makeBlock(3, replacement2.hash, [makeCoinbaseTx(1, 30 * SATOSHI)]);
      addBlockToState(state, block3);

      await waitForHeight(tracker, 3, 30000);

      // verifyReorg was called (reorg was detected)
      expect(reorgSpy.called).to.be.true;

      // Tracker recovered and continued
      expect(await tracker.db.getLastBlockHeight()).to.equal(3);
    });
  });
});
