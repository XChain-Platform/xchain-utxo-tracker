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
  SATOSHI, TEST_KEYS,
  makeCoinbaseTx, makeBlock, processBlock,
  createTestTracker, closeTracker
} = require('./helpers');

describe('Integration: Batch Boundaries', function () {
  let tracker;

  beforeEach(async function () {
    tracker = await createTestTracker();
  });

  afterEach(async function () {
    await closeTracker(tracker);
  });

  describe('mid-batch state isolation', function () {
    it('uncommitted state is not visible via direct DB reads', async function () {
      await tracker.db.beginTransaction();

      const block0 = makeBlock(0, '0'.repeat(64), [makeCoinbaseTx(0, 50 * SATOSHI)]);
      await processBlock(tracker, block0);

      const stored = await tracker.db.getBlock(block0.hash);
      expect(stored).to.be.null;

      // LevelDB reads bypass the in-memory transaction buffer, so this also
      // finds nothing pre-commit even though it queries a different path.
      const outputs = await tracker.db.getOutputsScriptPubKey(TEST_KEYS[0].scriptHash);
      expect(outputs).to.have.length(0);

      await tracker.db.endTransaction();

      const storedAfter = await tracker.db.getBlock(block0.hash);
      expect(storedAfter).to.not.be.null;
      expect(storedAfter.h).to.equal(0);

      const outputsAfter = await tracker.db.getOutputsScriptPubKey(TEST_KEYS[0].scriptHash);
      expect(outputsAfter).to.have.length(1);
    });
  });

  describe('multi-block batch commit', function () {
    it('atomically commits multiple blocks in a single batch', async function () {
      await tracker.db.beginTransaction();

      let prevHash = '0'.repeat(64);
      const blocks = [];

      for (let i = 0; i < 10; i++) {
        const block = makeBlock(i, prevHash, [makeCoinbaseTx(0, (i + 1) * SATOSHI)]);
        await processBlock(tracker, block);
        blocks.push(block);
        prevHash = block.hash;
      }

      const midOutputs = await tracker.db.getOutputsScriptPubKey(TEST_KEYS[0].scriptHash);
      expect(midOutputs).to.have.length(0);

      await tracker.db.endTransaction();
      await tracker.cleanupAgedBlocks();

      const outputs = await tracker.db.getOutputsScriptPubKey(TEST_KEYS[0].scriptHash);
      expect(outputs).to.have.length(10);

      // 1+2+...+10 = 55
      const info = await tracker.getBalanceInfo(TEST_KEYS[0].address);
      expect(info.balances.confirmed).to.equal('55.00000000');
      expect(info.utxos.confirmed).to.equal(10);

      const lastHeight = await tracker.db.getLastBlockHeight();
      expect(lastHeight).to.equal(9);

      const lastHash = await tracker.db.getLastBlockHash();
      expect(lastHash).to.equal(blocks[9].hash);
    });
  });

  describe('sequential batches', function () {
    it('state persists correctly across multiple batch commits', async function () {
      await tracker.db.beginTransaction();
      let prevHash = '0'.repeat(64);
      const batch1Blocks = [];
      for (let i = 0; i < 5; i++) {
        const block = makeBlock(i, prevHash, [makeCoinbaseTx(0, 10 * SATOSHI)]);
        await processBlock(tracker, block);
        batch1Blocks.push(block);
        prevHash = block.hash;
      }
      await tracker.db.endTransaction();
      await tracker.cleanupAgedBlocks();

      const info1 = await tracker.getBalanceInfo(TEST_KEYS[0].address);
      expect(info1.balances.confirmed).to.equal('50.00000000');

      await tracker.db.beginTransaction();
      const batch2Blocks = [];
      for (let i = 5; i < 10; i++) {
        const block = makeBlock(i, prevHash, [makeCoinbaseTx(0, 20 * SATOSHI)]);
        await processBlock(tracker, block);
        batch2Blocks.push(block);
        prevHash = block.hash;
      }
      await tracker.db.endTransaction();
      await tracker.cleanupAgedBlocks();

      const info2 = await tracker.getBalanceInfo(TEST_KEYS[0].address);
      expect(info2.balances.confirmed).to.equal('150.00000000'); // 50 + 100

      const utxos = await tracker.getUtxosAddress(TEST_KEYS[0].address);
      expect(utxos).to.have.length(10);

      const lastHeight = await tracker.db.getLastBlockHeight();
      expect(lastHeight).to.equal(9);
    });
  });

  describe('empty batch', function () {
    it('begin+end with no operations does not corrupt state', async function () {
      await tracker.db.beginTransaction();
      const block = makeBlock(0, '0'.repeat(64), [makeCoinbaseTx(0, 50 * SATOSHI)]);
      await processBlock(tracker, block);
      await tracker.db.endTransaction();

      await tracker.db.beginTransaction();
      await tracker.db.endTransaction();

      const info = await tracker.getBalanceInfo(TEST_KEYS[0].address);
      expect(info.balances.confirmed).to.equal('50.00000000');
    });
  });
});
