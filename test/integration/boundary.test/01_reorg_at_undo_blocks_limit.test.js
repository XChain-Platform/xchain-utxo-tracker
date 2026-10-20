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
  SATOSHI, TEST_KEYS, makeOutput, makeSpendInput, makeTx, makeCoinbaseTx, makeBlock,
  processAndCommit, processBlocksAndCommit, buildCoinbaseChain,
  createTestTracker, closeTracker, coinAmount, randHash
} = require('../support/helpers');

// Address roles in the fork below.
const OWNER = 0;
const PAYEE = 1;
const KEPT_MINER = 2;
const ORPHAN_MINER = 3;

// Commits each block in its own batch, so every spend resolves through the stored
// outputs and writes the recovery records a rollback reads.
async function commitChain(tracker, blocks) {
  for (const block of blocks) await processAndCommit(tracker, block);
}

// A chain whose last `depth` blocks are orphaned: two outputs owned before the fork,
// one spent by the deepest orphan and one by the orphaned tip.
function buildForkAtDepth(depth) {
  const ownedA = makeCoinbaseTx(OWNER, 50 * SATOSHI);
  const ownedB = makeCoinbaseTx(OWNER, 50 * SATOSHI);
  const kept = [makeBlock(0, '0'.repeat(64), [ownedA])];
  kept.push(makeBlock(1, kept[0].hash, [ownedB]));
  kept.push(makeBlock(2, kept[1].hash, [makeCoinbaseTx(KEPT_MINER)]));
  const spends = [ownedA, ownedB].map((owned) => makeTx({
    ins: [makeSpendInput(owned._txid, 0)], outs: [makeOutput(PAYEE, 50 * SATOSHI)]
  }));
  const orphans = [];
  for (let i = 0; i < depth; i++) {
    const txs = [makeCoinbaseTx(ORPHAN_MINER)];
    if (i === 0) txs.push(spends[0]);
    if (i === depth - 1) txs.push(spends[1]);
    const prev = (orphans[i - 1] || kept[kept.length - 1]).hash;
    orphans.push(makeBlock(kept.length + i, prev, txs));
  }
  return { kept, orphans };
}

// The node agrees on every kept height and reports a different hash above them.
function stubNodeChain(tracker, kept, tipHeight) {
  const getBlockHash = sinon.stub(tracker.connector, 'getBlockHash');
  kept.forEach((block) => getBlockHash.withArgs(block.height).resolves(block.hash));
  for (let h = kept.length; h <= tipHeight; h++) getBlockHash.withArgs(h).resolves(randHash());
}

// verifyReorg runs outside a batch in production, so the harness drops any open one first.
async function runVerifyReorg(tracker) {
  if (tracker.db.transactionArray) await tracker.db.endTransaction(false);
  tracker.db.transactionArray = null;
  tracker.db.deletedTransactionArray = null;
  await tracker.verifyReorg();
}

async function confirmedFor(tracker, index) {
  return (await tracker.getBalanceInfo(TEST_KEYS[index].address)).utxos.confirmed;
}

// 6. Reorg at UNDO_BLOCKS boundary
describe('Boundary: Reorg at UNDO_BLOCKS limit', function () {
  let tracker;

  beforeEach(async function () { tracker = await createTestTracker(); });
  afterEach(async function () { sinon.restore(); await closeTracker(tracker); });

  it('recovers spent outputs during reorg within the UNDO_BLOCKS window', async function () {
    // A fork exactly as deep as the window: its deepest orphan is the oldest block whose recovery records the cleanup keeps.
    tracker.undoBlocks = 3;
    const { kept, orphans } = buildForkAtDepth(tracker.undoBlocks);
    await commitChain(tracker, kept.concat(orphans));
    tracker.lastBlocks = await tracker.loadLastBlocksSortedByHeight();
    expect(tracker.lastBlocks).to.deep.equal(orphans.map((b) => b.hash));
    expect(await confirmedFor(tracker, OWNER)).to.equal(0);

    stubNodeChain(tracker, kept, orphans[orphans.length - 1].height);
    await runVerifyReorg(tracker);

    expect(await tracker.db.getLastBlockHeight()).to.equal(kept.length - 1);
    expect(await tracker.db.getLastBlockHash()).to.equal(kept[kept.length - 1].hash);
    expect(tracker.lastBlocks).to.deep.equal([]);
    const owned = await tracker.getUtxosAddress(TEST_KEYS[OWNER].address);
    expect(owned.map((u) => u.amount)).to.deep.equal([coinAmount(50), coinAmount(50)]);
    expect(await confirmedFor(tracker, PAYEE)).to.equal(0);
    expect(await confirmedFor(tracker, ORPHAN_MINER)).to.equal(0);
    expect(await confirmedFor(tracker, KEPT_MINER)).to.equal(1);
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
