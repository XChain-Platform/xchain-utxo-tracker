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


// The depth guard and re-indexing halves of ../reorg.test.js: a reorg deeper
// than the undo window aborts, and a replacement block re-creates what the
// rollback removed.

const { expect } = require('chai');
const sinon = require('sinon');
const {
  SATOSHI, TEST_KEYS,
  makeCoinbaseTx, makeBlock, processAndCommit, processBlocksAndCommit,
  createTestTracker, closeTracker, randHash
} = require('../support/helpers');

let tracker;

function useTracker() {
  beforeEach(async function () {
    tracker = await createTestTracker();
  });

  afterEach(async function () {
    sinon.restore();
    await closeTracker(tracker);
  });
}

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

// K/M recovery records are retained only for the most recent undoBlocks
// blocks. Once a reorg has already rolled back undoBlocks blocks, the next
// block's recovery records are gone, so verifyReorg must abort loudly
// rather than silently leave the UTXO index under-counted.
describe('Integration: Chain Reorganization', function () {
  useTracker();

  describe('reorg depth guard', function () {
    it('throws once blocksDeleted reaches the undo-depth window', async function () {
      // Small window so the test stays fast.
      // Use a small window so the test stays fast.
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
      // Node forks everything above the genesis block: every height past 0
      // mismatches, forcing a rollback deeper than the undo window.
      const getBlockHash = sinon.stub(tracker.connector, 'getBlockHash');
      getBlockHash.withArgs(0).resolves(blocks[0].hash);
      for (let i = 1; i <= 7; i++) getBlockHash.withArgs(i).resolves(randHash());

      tracker.lastBlocks = await tracker.loadLastBlocksSortedByHeight();

      // verifyReorg rolls back undoBlocks (3) blocks, then aborts on the next.
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
});

describe('Integration: Chain Reorganization', function () {
  useTracker();

  describe('reorg then re-index', function () {
    it('new S record is created when replacement block arrives', async function () {
      const block0 = makeBlock(0, '0'.repeat(64), [makeCoinbaseTx(0)]);
      const block1 = makeBlock(1, block0.hash, [makeCoinbaseTx(1, 5 * SATOSHI)]);
      await processBlocksAndCommit(tracker, [block0, block1]);

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
