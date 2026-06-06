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
  SATOSHI, TEST_KEYS,
  makeCoinbaseTx, makeBlock, makeOutput, makeSpendInput, makeTx,
  processBlock, processAndCommit, processBlocksAndCommit,
  createTestTracker, closeTracker, randHash,
  corruptStateAnchor, deleteStateAnchors, forceVerifyReorg,
  buildCommittedChain
} = require('./chaos-helpers');

describe('Chaos: State Corruption', function () {
  let tracker;

  beforeEach(async function () {
    tracker = await createTestTracker();
    // Override sleep to avoid 3-second delays in verifyReorg retry loops
    tracker.sleep = async () => {};
  });

  afterEach(async function () {
    sinon.restore();
    await closeTracker(tracker);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Experiment 3: State Anchor Corruption (LDB-04)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Exp 3a: Corrupted Block Height', function () {

    it('verifyReorg self-heals when height is set to future value', async function () {
      const blocks = await buildCommittedChain(tracker, 5);
      expect(await tracker.db.getLastBlockHeight()).to.equal(4);

      // Corrupt: set height to 9999 while hash still points to block 4
      await corruptStateAnchor(tracker.db, { height: 9999 });

      expect(await tracker.db.getLastBlockHeight()).to.equal(9999);

      // Stub connector to return correct hashes (verifyReorg queries the node)
      const getBlockHash = sinon.stub(tracker.connector, 'getBlockHash');
      for (let i = 0; i <= 4; i++) {
        getBlockHash.withArgs(i).resolves(blocks[i].hash);
      }

      // verifyReorg should detect the height/block mismatch and self-heal
      // via the getLastBlock() scan path (XChainUtxoTracker.js:492-502)
      await forceVerifyReorg(tracker);

      // Height corrected back to 4
      expect(await tracker.db.getLastBlockHeight()).to.equal(4);
      expect(await tracker.db.getLastBlockHash()).to.equal(blocks[4].hash);
    });
  });

  describe('Exp 3b: Corrupted Block Hash', function () {

    it('verifyReorg self-heals when hash is garbage', async function () {
      const blocks = await buildCommittedChain(tracker, 5);

      // Corrupt: set hash to garbage (getBlock will return null)
      const garbageHash = 'aa'.repeat(32);
      await corruptStateAnchor(tracker.db, { hash: garbageHash });

      expect(await tracker.db.getLastBlockHash()).to.equal(garbageHash);

      // Stub connector
      const getBlockHash = sinon.stub(tracker.connector, 'getBlockHash');
      for (let i = 0; i <= 4; i++) {
        getBlockHash.withArgs(i).resolves(blocks[i].hash);
      }

      await forceVerifyReorg(tracker);

      // Self-healed: hash and height match the real chain tip
      const finalHeight = await tracker.db.getLastBlockHeight();
      const finalHash = await tracker.db.getLastBlockHash();
      expect(finalHeight).to.equal(4);
      expect(finalHash).to.equal(blocks[4].hash);
    });
  });

  describe('Exp 3c: Missing State Anchors', function () {

    it('returns sentinel values when both anchors are deleted', async function () {
      const blocks = await buildCommittedChain(tracker, 3);

      await deleteStateAnchors(tracker.db);

      // getLastBlockHeight returns -1 (sentinel), getLastBlockHash returns null
      expect(await tracker.db.getLastBlockHeight()).to.equal(-1);
      expect(await tracker.db.getLastBlockHash()).to.be.null;
    });

    it('blocks can be re-indexed from scratch after anchor deletion', async function () {
      const blocks = await buildCommittedChain(tracker, 3, 0);
      await deleteStateAnchors(tracker.db);

      // Re-process the chain — simulates restart from genesis
      await processBlocksAndCommit(tracker, blocks);

      expect(await tracker.db.getLastBlockHeight()).to.equal(2);
      expect(await tracker.db.getLastBlockHash()).to.equal(blocks[2].hash);

      const info = await tracker.getBalanceInfo(TEST_KEYS[0].address);
      expect(info.balances.confirmed).to.equal('150.00000000');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Experiment 6: Reorg During Batch (STATE-01)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Exp 6: Chain Reorganization During Uncommitted Batch', function () {

    it('uncommitted batch blocks are discarded on reorg', async function () {
      // Commit blocks 0–4
      const blocks = await buildCommittedChain(tracker, 5, 0);
      expect(await tracker.db.getLastBlockHeight()).to.equal(4);

      // Start new batch (in-memory), process blocks 5–6
      await tracker.db.beginTransaction();
      const block5 = makeBlock(5, blocks[4].hash, [makeCoinbaseTx(1, 10 * SATOSHI)]);
      const block6 = makeBlock(6, block5.hash, [makeCoinbaseTx(1, 10 * SATOSHI)]);
      await processBlock(tracker, block5);
      await processBlock(tracker, block6);

      // Node reports different hash at height 4 (reorg invalidates block 4)
      sinon.stub(tracker.connector, 'getBlockHash')
        .withArgs(3).resolves(blocks[3].hash)
        .withArgs(4).resolves(randHash());

      // forceVerifyReorg discards the uncommitted batch and rolls back
      await forceVerifyReorg(tracker);

      // Rolled back to block 3 (block 4 deleted by reorg)
      expect(await tracker.db.getLastBlockHeight()).to.equal(3);
      expect(await tracker.db.getLastBlockHash()).to.equal(blocks[3].hash);

      // Blocks 4, 5, 6 are not in the DB
      expect(await tracker.db.getBlock(blocks[4].hash)).to.be.null;
      expect(await tracker.db.getBlock(block5.hash)).to.be.null;
      expect(await tracker.db.getBlock(block6.hash)).to.be.null;

      // Block 3 is intact
      const b3 = await tracker.db.getBlock(blocks[3].hash);
      expect(b3).to.not.be.null;
      expect(b3.h).to.equal(3);
    });

    it('replacement blocks can be processed after reorg discards batch', async function () {
      const blocks = await buildCommittedChain(tracker, 4, 0);

      // Start batch, process block 4 (in-memory)
      await tracker.db.beginTransaction();
      const block4 = makeBlock(4, blocks[3].hash, [makeCoinbaseTx(1, 20 * SATOSHI)]);
      await processBlock(tracker, block4);

      // Reorg at height 3
      sinon.stub(tracker.connector, 'getBlockHash')
        .withArgs(2).resolves(blocks[2].hash)
        .withArgs(3).resolves(randHash());

      await forceVerifyReorg(tracker);
      expect(await tracker.db.getLastBlockHeight()).to.equal(2);

      // Process replacement blocks
      const newBlock3 = makeBlock(3, blocks[2].hash, [makeCoinbaseTx(2, 30 * SATOSHI)]);
      const newBlock4 = makeBlock(4, newBlock3.hash, [makeCoinbaseTx(2, 30 * SATOSHI)]);
      await processBlocksAndCommit(tracker, [newBlock3, newBlock4]);

      expect(await tracker.db.getLastBlockHeight()).to.equal(4);
      expect(await tracker.db.getLastBlockHash()).to.equal(newBlock4.hash);

      // addr 2 received both replacement coinbases
      const info = await tracker.getBalanceInfo(TEST_KEYS[2].address);
      expect(info.balances.confirmed).to.equal('60.00000000');

      // addr 1 received nothing (its block was in the discarded batch)
      const info1 = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(info1.balances.confirmed).to.equal('0.00000000');
    });

    it('reorg restores spent outputs from K/M archives', async function () {
      // Block 0: coinbase 50 BTC to addr0
      const cb = makeCoinbaseTx(0, 50 * SATOSHI);
      const block0 = makeBlock(0, '0'.repeat(64), [cb]);
      await processAndCommit(tracker, block0);

      // Block 1: spend addr0's UTXO → addr1
      const spendTx = makeTx({
        ins: [makeSpendInput(cb._txid, 0)],
        outs: [makeOutput(1, 49 * SATOSHI)]
      });
      const block1 = makeBlock(1, block0.hash, [makeCoinbaseTx(2), spendTx]);
      await processAndCommit(tracker, block1);

      // addr0 balance is 0 (spent), addr1 has 49
      expect((await tracker.getBalanceInfo(TEST_KEYS[0].address)).balances.confirmed)
        .to.equal('0.00000000');
      expect((await tracker.getBalanceInfo(TEST_KEYS[1].address)).balances.confirmed)
        .to.equal('49.00000000');

      // Start a batch (in-memory), process block 2
      await tracker.db.beginTransaction();
      const block2 = makeBlock(2, block1.hash, [makeCoinbaseTx(3)]);
      await processBlock(tracker, block2);

      // Reorg removes block 1 (the spending block)
      sinon.stub(tracker.connector, 'getBlockHash')
        .withArgs(0).resolves(block0.hash)
        .withArgs(1).resolves(randHash());

      await forceVerifyReorg(tracker);

      // addr0's UTXO is restored via K/M recovery
      expect(await tracker.db.getLastBlockHeight()).to.equal(0);
      const infoAfter = await tracker.getBalanceInfo(TEST_KEYS[0].address);
      expect(infoAfter.balances.confirmed).to.equal('50.00000000');
      expect(infoAfter.utxos.confirmed).to.equal(1);
    });
  });
});
