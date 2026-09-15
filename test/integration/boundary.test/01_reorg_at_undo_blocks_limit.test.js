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
  SATOSHI, TEST_KEYS, makeOutput, makeSpendInput, makeTx, makeCoinbaseTx, makeBlock,
  processAndCommit, processBlocksAndCommit, buildCoinbaseChain,
  createTestTracker, closeTracker, coinAmount
} = require('../support/helpers');

// 6. Reorg at UNDO_BLOCKS boundary
describe('Boundary: Reorg at UNDO_BLOCKS limit', function () {
  let tracker;

  beforeEach(async function () { tracker = await createTestTracker(); });
  afterEach(async function () { await closeTracker(tracker); });

  it('recovers spent outputs during reorg within the UNDO_BLOCKS window', async function () {
    // Block 0: coinbase to address 0 (50 BTC)
    const coinbase = makeCoinbaseTx(0, 50 * SATOSHI);
    const block0 = makeBlock(0, '0'.repeat(64), [coinbase]);

    // Block 1: spend coinbase to address 1
    const spendTx = makeTx({
      ins: [makeSpendInput(coinbase._txid, 0)],
      outs: [makeOutput(1, 50 * SATOSHI)]
    });
    const block1 = makeBlock(1, block0.hash, [makeCoinbaseTx(2), spendTx]);

    await processAndCommit(tracker, block0);
    await processAndCommit(tracker, block1);

    // Address 0 should have 0 UTXOs (spent)
    let utxos0 = await tracker.getUtxosAddress(TEST_KEYS[0].address);
    expect(utxos0).to.have.length(0);

    // Simulate a reorg by undoing block1's writes directly against the db layer.
    // Simulate reorg: remove block 1's outputs and recover deletions
    await tracker.db.beginTransaction();
    await tracker.db.removeOutputScriptsInBlock(block1.hash);
    await tracker.db.processDeletedOutputs(block1.hash, true);
    await tracker.db.deleteBlock(block1.hash);
    await tracker.db.setLastBlockHeight(0);
    await tracker.db.setLastBlockHash(block0.hash);
    await tracker.db.endTransaction();

    // Address 0 should have its UTXO back
    utxos0 = await tracker.getUtxosAddress(TEST_KEYS[0].address);
    expect(utxos0).to.have.length(1);
    expect(utxos0[0].amount).to.equal(coinAmount(50));
  });
});

describe('Boundary: Reorg at UNDO_BLOCKS limit', function () {
  let tracker;

  beforeEach(async function () { tracker = await createTestTracker(); });
  afterEach(async function () { await closeTracker(tracker); });

  it('cleans up K/M for blocks exiting the UNDO_BLOCKS window', async function () {
    // The window is per-chain (src/chain/undo_blocks.js: BTC 12 / LTC 120 / DOGE 120), so
    // size the chain from tracker.undoBlocks rather than the flat 10 this test was
    // written against; two blocks past the window must age out of lastBlocks.
    const window = tracker.undoBlocks;
    const total = window + 2;
    const blocks = buildCoinbaseChain(total, 0, 0);
    await processBlocksAndCommit(tracker, blocks);

    const height = await tracker.db.getLastBlockHeight();
    expect(height).to.equal(total - 1);

    // Only the most recent `window` hashes stay tracked, oldest-first.
    // Only the most recent `window` block hashes stay tracked...
    expect(tracker.lastBlocks).to.have.length(window);
    // ...and they are exactly the newest ones, oldest-first.
    expect(tracker.lastBlocks).to.deep.equal(blocks.slice(-window).map(b => b.hash));
  });

  it('maintains correct UTXO state across batch boundary (100 blocks)', async function () {
    const blocks = buildCoinbaseChain(101, 0, 0);
    // Process in one big batch (simulates batch commit at 100)
    await processBlocksAndCommit(tracker, blocks);

    const utxos = await tracker.getUtxosAddress(TEST_KEYS[0].address);
    expect(utxos).to.have.length(101);
  });
});
