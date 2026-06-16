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
  SATOSHI, TEST_KEYS,
  makeOutput, makeSpendInput, makeTx, makeCoinbaseTx,
  makeBlock, processBlock, processAndCommit, processBlocksAndCommit,
  createTestTracker, closeTracker, randHash
} = require('./helpers');

describe('Integration: Chain Reorganization', function () {
  let tracker;

  beforeEach(async function () {
    tracker = await createTestTracker();
  });

  afterEach(async function () {
    sinon.restore();
    await closeTracker(tracker);
  });

  // verifyReorg() runs with transactionArray=null in production (direct writes).
  // This helper matches that flow.
  async function runVerifyReorg() {
    if (tracker.db.transactionArray) {
      await tracker.db.endTransaction(false);
    }
    tracker.db.transactionArray = null;
    tracker.db.deletedTransactionArray = null;
    await tracker.verifyReorg();
  }

  // ─── Scenario 4.1: Single-Block Reorg — Height/Hash Rollback ─────────

  describe('single-block reorg', function () {
    it('rolls back block height and hash to the fork point', async function () {
      const blocks = [];
      let prevHash = '0'.repeat(64);

      for (let i = 0; i < 5; i++) {
        const block = makeBlock(i, prevHash, [makeCoinbaseTx(0, 10 * SATOSHI)]);
        blocks.push(block);
        prevHash = block.hash;
      }

      await processBlocksAndCommit(tracker, blocks);

      // Confirm pre-reorg state
      expect(await tracker.db.getLastBlockHeight()).to.equal(4);
      expect(await tracker.db.getLastBlockHash()).to.equal(blocks[4].hash);

      // Node reports different hash at height 4
      sinon.stub(tracker.connector, 'getBlockHash')
        .withArgs(3).resolves(blocks[3].hash)
        .withArgs(4).resolves(randHash());

      await runVerifyReorg();

      // Height/hash rolled back to block 3
      expect(await tracker.db.getLastBlockHeight()).to.equal(3);
      expect(await tracker.db.getLastBlockHash()).to.equal(blocks[3].hash);

      // Block 4's B record is deleted
      expect(await tracker.db.getBlock(blocks[4].hash)).to.be.null;

      // Block 3's B record is intact
      const block3 = await tracker.db.getBlock(blocks[3].hash);
      expect(block3).to.not.be.null;
      expect(block3.h).to.equal(3);
    });

    it('can process new blocks after reorg', async function () {
      const blocks = [];
      let prevHash = '0'.repeat(64);

      for (let i = 0; i < 3; i++) {
        const block = makeBlock(i, prevHash, [makeCoinbaseTx(0, 10 * SATOSHI)]);
        blocks.push(block);
        prevHash = block.hash;
      }

      await processBlocksAndCommit(tracker, blocks);

      // Reorg removes block 2
      sinon.stub(tracker.connector, 'getBlockHash')
        .withArgs(1).resolves(blocks[1].hash)
        .withArgs(2).resolves(randHash());

      await runVerifyReorg();
      expect(await tracker.db.getLastBlockHeight()).to.equal(1);

      // Process a replacement block at height 2
      const newBlock2 = makeBlock(2, blocks[1].hash, [makeCoinbaseTx(1, 25 * SATOSHI)]);
      await processAndCommit(tracker, newBlock2);

      // New block is correctly indexed
      expect(await tracker.db.getLastBlockHeight()).to.equal(2);
      expect(await tracker.db.getLastBlockHash()).to.equal(newBlock2.hash);

      // Address 1 received the new coinbase
      const info1 = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(info1.balances.confirmed).to.equal('25.00000000');
    });
  });

  // ─── Scenario 4.2: Multi-Block Reorg ──────────────────────────────────

  describe('multi-block reorg', function () {
    it('rolls back multiple blocks to the fork point', async function () {
      const blocks = [];
      let prevHash = '0'.repeat(64);

      for (let i = 0; i < 8; i++) {
        const block = makeBlock(i, prevHash, [makeCoinbaseTx(0, 10 * SATOSHI)]);
        blocks.push(block);
        prevHash = block.hash;
      }

      await processBlocksAndCommit(tracker, blocks);

      // Reorg: blocks 5-7 replaced (3-block reorg)
      const getBlockHash = sinon.stub(tracker.connector, 'getBlockHash');
      getBlockHash.withArgs(4).resolves(blocks[4].hash);
      getBlockHash.withArgs(5).resolves(randHash());
      getBlockHash.withArgs(6).resolves(randHash());
      getBlockHash.withArgs(7).resolves(randHash());

      await runVerifyReorg();

      // Rolled back to block 4
      expect(await tracker.db.getLastBlockHeight()).to.equal(4);
      expect(await tracker.db.getLastBlockHash()).to.equal(blocks[4].hash);

      // Blocks 5-7 B records deleted
      for (let i = 5; i <= 7; i++) {
        expect(await tracker.db.getBlock(blocks[i].hash)).to.be.null;
      }

      // Blocks 0-4 B records intact
      for (let i = 0; i <= 4; i++) {
        const b = await tracker.db.getBlock(blocks[i].hash);
        expect(b, `block ${i}`).to.not.be.null;
        expect(b.h).to.equal(i);
      }
    });
  });

  // ─── Scenario 4.3: Reorg Restores Previously Spent Output ─────────────

  describe('reorg restores spent output', function () {
    it('unspends outputs when the spending block is rolled back', async function () {
      // Block 0: coinbase 50 BTC to addr0 — committed in batch 1
      const cb = makeCoinbaseTx(0, 50 * SATOSHI);
      const block0 = makeBlock(0, '0'.repeat(64), [cb]);
      await processAndCommit(tracker, block0);

      // Block 1: filler — committed in batch 2
      const block1 = makeBlock(1, block0.hash, [makeCoinbaseTx(2)]);
      await processAndCommit(tracker, block1);

      // Block 2: spend addr0's UTXO — committed in batch 3
      // Since block0's O/H are committed, removeOutputWithInput uses the DB path,
      // creating K/M records that allow restoration on reorg.
      const spendTx = makeTx({
        ins: [makeSpendInput(cb._txid, 0)],
        outs: [makeOutput(1, 49 * SATOSHI)]
      });
      const block2 = makeBlock(2, block1.hash, [makeCoinbaseTx(3), spendTx]);
      await processAndCommit(tracker, block2);

      // Before reorg: addr0 has 0 (spent), addr1 has 49
      const infoBefore0 = await tracker.getBalanceInfo(TEST_KEYS[0].address);
      expect(infoBefore0.balances.confirmed).to.equal('0.00000000');

      const infoBefore1 = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(infoBefore1.balances.confirmed).to.equal('49.00000000');

      // Reorg removes block 2 (the spending block)
      sinon.stub(tracker.connector, 'getBlockHash')
        .withArgs(1).resolves(block1.hash)
        .withArgs(2).resolves(randHash());

      await runVerifyReorg();

      // After reorg: height rolled back
      expect(await tracker.db.getLastBlockHeight()).to.equal(1);

      // addr0's UTXO is restored via processDeletedOutputs (K/M recovery)
      const infoAfter0 = await tracker.getBalanceInfo(TEST_KEYS[0].address);
      expect(infoAfter0.balances.confirmed).to.equal('50.00000000');
      expect(infoAfter0.utxos.confirmed).to.equal(1);

      // addr1's 49 BTC output was CREATED in the rolled-back block and never
      // spent — it must not survive as a phantom UTXO (W-index cleanup).
      const infoAfter1 = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(infoAfter1.balances.confirmed).to.equal('0.00000000');
      expect(infoAfter1.utxos.confirmed).to.equal(0);
    });
  });

  // ─── Scenario 4.4: S record cleanup on reorg ─────────────────────────

  describe('S record cleanup on reorg', function () {
    it('removes script-block records for rolled-back blocks', async function () {
      // Block 0: coinbase to addr0
      const block0 = makeBlock(0, '0'.repeat(64), [makeCoinbaseTx(0)]);
      await processAndCommit(tracker, block0);

      // Block 1: first tx to addr1 (creates S record)
      const block1 = makeBlock(1, block0.hash, [makeCoinbaseTx(1, 10 * SATOSHI)]);
      await processAndCommit(tracker, block1);

      // S record exists for addr1
      const sBefore = await tracker.db.getOutputScriptBlock(TEST_KEYS[1].scriptHash);
      expect(sBefore).to.not.be.null;
      expect(sBefore.h).to.equal(1);

      // Reorg removes block 1
      sinon.stub(tracker.connector, 'getBlockHash')
        .withArgs(0).resolves(block0.hash)
        .withArgs(1).resolves(randHash());

      await runVerifyReorg();

      // S record for addr1 cleaned up
      const sAfter = await tracker.db.getOutputScriptBlock(TEST_KEYS[1].scriptHash);
      expect(sAfter).to.be.null;

      // S record for addr0 still exists (block 0 not reorged)
      const s0 = await tracker.db.getOutputScriptBlock(TEST_KEYS[0].scriptHash);
      expect(s0).to.not.be.null;
    });
  });

  // ─── Scenario 4.5: Reorg then re-index creates correct S record ──────

  describe('reorg then re-index', function () {
    it('new S record is created when replacement block arrives', async function () {
      const block0 = makeBlock(0, '0'.repeat(64), [makeCoinbaseTx(0)]);
      const block1 = makeBlock(1, block0.hash, [makeCoinbaseTx(1, 5 * SATOSHI)]);
      await processBlocksAndCommit(tracker, [block0, block1]);

      // Reorg removes block 1
      sinon.stub(tracker.connector, 'getBlockHash')
        .withArgs(0).resolves(block0.hash)
        .withArgs(1).resolves(randHash());

      await runVerifyReorg();

      // S record for addr1 is gone
      expect(await tracker.db.getOutputScriptBlock(TEST_KEYS[1].scriptHash)).to.be.null;

      // Process replacement block 1' that also sends to addr1
      const newBlock1 = makeBlock(1, block0.hash, [makeCoinbaseTx(1, 8 * SATOSHI)]);
      await processAndCommit(tracker, newBlock1);

      // S record re-created for addr1 at height 1
      const sNew = await tracker.db.getOutputScriptBlock(TEST_KEYS[1].scriptHash);
      expect(sNew).to.not.be.null;
      expect(sNew.h).to.equal(1);
    });
  });
});
