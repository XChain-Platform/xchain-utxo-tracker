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

      expect(await tracker.db.getLastBlockHeight()).to.equal(4);
      expect(await tracker.db.getLastBlockHash()).to.equal(blocks[4].hash);

      sinon.stub(tracker.connector, 'getBlockHash')
        .withArgs(3).resolves(blocks[3].hash)
        .withArgs(4).resolves(randHash());

      await runVerifyReorg();

      expect(await tracker.db.getLastBlockHeight()).to.equal(3);
      expect(await tracker.db.getLastBlockHash()).to.equal(blocks[3].hash);

      expect(await tracker.db.getBlock(blocks[4].hash)).to.be.null;

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

      sinon.stub(tracker.connector, 'getBlockHash')
        .withArgs(1).resolves(blocks[1].hash)
        .withArgs(2).resolves(randHash());

      await runVerifyReorg();
      expect(await tracker.db.getLastBlockHeight()).to.equal(1);

      const newBlock2 = makeBlock(2, blocks[1].hash, [makeCoinbaseTx(1, 25 * SATOSHI)]);
      await processAndCommit(tracker, newBlock2);

      expect(await tracker.db.getLastBlockHeight()).to.equal(2);
      expect(await tracker.db.getLastBlockHash()).to.equal(newBlock2.hash);

      const info1 = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(info1.balances.confirmed).to.equal('25.00000000');
    });
  });

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

      const getBlockHash = sinon.stub(tracker.connector, 'getBlockHash');
      getBlockHash.withArgs(4).resolves(blocks[4].hash);
      getBlockHash.withArgs(5).resolves(randHash());
      getBlockHash.withArgs(6).resolves(randHash());
      getBlockHash.withArgs(7).resolves(randHash());

      await runVerifyReorg();

      expect(await tracker.db.getLastBlockHeight()).to.equal(4);
      expect(await tracker.db.getLastBlockHash()).to.equal(blocks[4].hash);

      for (let i = 5; i <= 7; i++) {
        expect(await tracker.db.getBlock(blocks[i].hash)).to.be.null;
      }

      for (let i = 0; i <= 4; i++) {
        const b = await tracker.db.getBlock(blocks[i].hash);
        expect(b, `block ${i}`).to.not.be.null;
        expect(b.h).to.equal(i);
      }
    });
  });

  describe('reorg restores spent output', function () {
    it('unspends outputs when the spending block is rolled back', async function () {
      const cb = makeCoinbaseTx(0, 50 * SATOSHI);
      const block0 = makeBlock(0, '0'.repeat(64), [cb]);
      await processAndCommit(tracker, block0);

      const block1 = makeBlock(1, block0.hash, [makeCoinbaseTx(2)]);
      await processAndCommit(tracker, block1);

      // Block 0 and block 1 are each committed in their own batch, so
      // block 2's spend of block 0's output resolves through the DB path
      // (removeOutputWithInput), which writes the K/M records reorg
      // recovery depends on to restore the output below.
      const spendTx = makeTx({
        ins: [makeSpendInput(cb._txid, 0)],
        outs: [makeOutput(1, 49 * SATOSHI)]
      });
      const block2 = makeBlock(2, block1.hash, [makeCoinbaseTx(3), spendTx]);
      await processAndCommit(tracker, block2);

      const infoBefore0 = await tracker.getBalanceInfo(TEST_KEYS[0].address);
      expect(infoBefore0.balances.confirmed).to.equal('0.00000000');

      const infoBefore1 = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(infoBefore1.balances.confirmed).to.equal('49.00000000');

      sinon.stub(tracker.connector, 'getBlockHash')
        .withArgs(1).resolves(block1.hash)
        .withArgs(2).resolves(randHash());

      await runVerifyReorg();

      expect(await tracker.db.getLastBlockHeight()).to.equal(1);

      // addr0's UTXO is restored via processDeletedOutputs (K/M recovery).
      const infoAfter0 = await tracker.getBalanceInfo(TEST_KEYS[0].address);
      expect(infoAfter0.balances.confirmed).to.equal('50.00000000');
      expect(infoAfter0.utxos.confirmed).to.equal(1);

      // addr1's output was created in the rolled-back block and never spent;
      // it must not survive as a phantom UTXO (W-index cleanup).
      const infoAfter1 = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(infoAfter1.balances.confirmed).to.equal('0.00000000');
      expect(infoAfter1.utxos.confirmed).to.equal(0);
    });
  });

  describe('S record cleanup on reorg', function () {
    it('removes script-block records for rolled-back blocks', async function () {
      const block0 = makeBlock(0, '0'.repeat(64), [makeCoinbaseTx(0)]);
      await processAndCommit(tracker, block0);

      // First tx to addr1; this is what creates its S record.
      const block1 = makeBlock(1, block0.hash, [makeCoinbaseTx(1, 10 * SATOSHI)]);
      await processAndCommit(tracker, block1);

      const sBefore = await tracker.db.getOutputScriptBlock(TEST_KEYS[1].scriptHash);
      expect(sBefore).to.not.be.null;
      expect(sBefore.h).to.equal(1);

      sinon.stub(tracker.connector, 'getBlockHash')
        .withArgs(0).resolves(block0.hash)
        .withArgs(1).resolves(randHash());

      await runVerifyReorg();

      const sAfter = await tracker.db.getOutputScriptBlock(TEST_KEYS[1].scriptHash);
      expect(sAfter).to.be.null;

      // block 0 was not reorged, so its S record persists.
      const s0 = await tracker.db.getOutputScriptBlock(TEST_KEYS[0].scriptHash);
      expect(s0).to.not.be.null;
    });
  });

  // Regression guard for a silent-UTXO-loss bug: when create(N) and spend(N+k)
  // land in one uncommitted batch, the spend resolves the output from the
  // in-memory staging map rather than the DB. Before the fix, that path wrote
  // no durable K/M restore records, so a later reorg could not unspend the
  // output and its balance vanished permanently.
  describe('cross-block in-batch spend reorg recovery', function () {
    it('restores a UTXO created and spent across blocks of one committed batch', async function () {
      // Block 0/1/2 are all processed in one batch (single begin/endTransaction),
      // so the spend resolves block 0's output from in-memory staging, not the DB.
      const cb = makeCoinbaseTx(0, 50 * SATOSHI);
      const block0 = makeBlock(0, '0'.repeat(64), [cb]);
      const block1 = makeBlock(1, block0.hash, [makeCoinbaseTx(2)]);
      const spendTx = makeTx({
        ins: [makeSpendInput(cb._txid, 0)],
        outs: [makeOutput(1, 49 * SATOSHI)]
      });
      const block2 = makeBlock(2, block1.hash, [makeCoinbaseTx(3), spendTx]);

      await processBlocksAndCommit(tracker, [block0, block1, block2]);

      const before0 = await tracker.getBalanceInfo(TEST_KEYS[0].address);
      expect(before0.balances.confirmed).to.equal('0.00000000');

      const getBlockHash = sinon.stub(tracker.connector, 'getBlockHash');
      getBlockHash.withArgs(0).resolves(block0.hash);
      getBlockHash.withArgs(1).resolves(randHash());
      getBlockHash.withArgs(2).resolves(randHash());

      tracker.lastBlocks = await tracker.loadLastBlocksSortedByHeight();
      await runVerifyReorg();

      expect(await tracker.db.getLastBlockHeight()).to.equal(0);

      // Rolling back block 2 (the spend block) replays the K/M records
      // written by the cross-block in-memory path, restoring the coinbase UTXO.
      const after0 = await tracker.getBalanceInfo(TEST_KEYS[0].address);
      expect(after0.balances.confirmed).to.equal('50.00000000');
      expect(after0.utxos.confirmed).to.equal(1);

      // addr1's output was created in a rolled-back block and never spent:
      // it must not survive as a phantom UTXO.
      const after1 = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(after1.balances.confirmed).to.equal('0.00000000');
      expect(after1.utxos.confirmed).to.equal(0);
    });
  });

  // K/M recovery records are retained only for the most recent undoBlocks
  // blocks. Once a reorg has already rolled back undoBlocks blocks, the next
  // block's recovery records are gone, so verifyReorg must abort loudly
  // rather than silently leave the UTXO index under-counted.
  describe('reorg depth guard', function () {
    it('throws once blocksDeleted reaches the undo-depth window', async function () {
      // Small window so the test stays fast.
      tracker.undoBlocks = 3;

      const blocks = [];
      let prevHash = '0'.repeat(64);
      for (let i = 0; i < 8; i++) {
        const block = makeBlock(i, prevHash, [makeCoinbaseTx(0, 10 * SATOSHI)]);
        blocks.push(block);
        prevHash = block.hash;
      }
      await processBlocksAndCommit(tracker, blocks);

      // Every height past genesis mismatches, forcing a rollback deeper
      // than the undo window.
      const getBlockHash = sinon.stub(tracker.connector, 'getBlockHash');
      getBlockHash.withArgs(0).resolves(blocks[0].hash);
      for (let i = 1; i <= 7; i++) getBlockHash.withArgs(i).resolves(randHash());

      tracker.lastBlocks = await tracker.loadLastBlocksSortedByHeight();

      let threw = false;
      try {
        await runVerifyReorg();
      } catch (err) {
        threw = true;
        expect(err.message).to.match(/reorg depth exceeds the recovery window/i);
      }
      expect(threw, 'verifyReorg should throw past the undo-depth window').to.equal(true);
    });
  });

  describe('reorg then re-index', function () {
    it('new S record is created when replacement block arrives', async function () {
      const block0 = makeBlock(0, '0'.repeat(64), [makeCoinbaseTx(0)]);
      const block1 = makeBlock(1, block0.hash, [makeCoinbaseTx(1, 5 * SATOSHI)]);
      await processBlocksAndCommit(tracker, [block0, block1]);

      sinon.stub(tracker.connector, 'getBlockHash')
        .withArgs(0).resolves(block0.hash)
        .withArgs(1).resolves(randHash());

      await runVerifyReorg();

      expect(await tracker.db.getOutputScriptBlock(TEST_KEYS[1].scriptHash)).to.be.null;

      const newBlock1 = makeBlock(1, block0.hash, [makeCoinbaseTx(1, 8 * SATOSHI)]);
      await processAndCommit(tracker, newBlock1);

      const sNew = await tracker.db.getOutputScriptBlock(TEST_KEYS[1].scriptHash);
      expect(sNew).to.not.be.null;
      expect(sNew.h).to.equal(1);
    });
  });
});
