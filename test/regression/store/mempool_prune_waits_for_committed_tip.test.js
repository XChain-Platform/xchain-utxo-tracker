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

// Regression: a mempool pass must not delete a tx the node has just mined into
// a block this tracker has not committed yet.
//
// T spends the confirmed coin X. The node mines T, so its mempool listing drops
// T, but the tracker is still fetching that block. If the mempool pass deleted T
// now, the confirmed store would still hold X unspent with no mempool spend
// over it, and get_utxos would serve X although it is already spent on chain.

const { expect } = require('chai');
const sinon = require('sinon');
const {
  SATOSHI, TEST_KEYS,
  makeOutput, makeSpendInput, makeTx, makeCoinbaseTx, makeBlock,
  stubBlockchain, addBlockToState, addMempoolTx, removeMempoolTx, clearMempool,
  waitForHeight, waitForSynced,
  createE2ETracker, patchLevelUpStoreInMemory
} = require('../../e2e/support/helpers');

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

// Holds every block fetch at or above `height` until release() is called.
function holdBlocksFrom(tracker, state, height) {
  const gate = deferred();
  const batch = tracker.connector.getBlocksBatch;
  const single = tracker.connector.getBlock;
  tracker.connector.getBlocksBatch = async (heights) => {
    if (heights.some(h => h >= height)) await gate.promise;
    return batch(heights);
  };
  tracker.connector.getBlock = async (hash) => {
    if (state.blocks.findIndex(b => b.hash === hash) >= height) await gate.promise;
    return single(hash);
  };
  return gate.resolve;
}

const outpoints = (utxos) => utxos.map(u => u.txid + ':' + u.vout);

// Builds a fresh in-memory tracker into the suite fixture.
function setUp(fx) {
  fx.restoreLevelUp = patchLevelUpStoreInMemory();
  fx.tracker = createE2ETracker();
  fx.release = null;
}

// Releases any held block fetch, then stops the tracker and restores the store.
async function tearDown(fx) {
  if (fx.release) fx.release();
  sinon.restore();
  await fx.tracker.stopParsing();
  fx.restoreLevelUp();
}

// Synced at block 0 holding X, with T (spends X) in both mempools.
async function syncedWithMempoolSpend(tracker) {
  const cb = makeCoinbaseTx(0, 50 * SATOSHI);
  const block0 = makeBlock(0, '0'.repeat(64), [cb]);
  const state = stubBlockchain(tracker, [block0]);
  tracker.start();
  await waitForSynced(tracker);
  const spend = makeTx({ ins: [makeSpendInput(cb.getId(), 0)], outs: [makeOutput(1, 10 * SATOSHI)] });
  addMempoolTx(state, spend);
  await tracker.updateMempool();
  return { state, cb, block0, spend };
}

describe('Regression: mempool prune waits for the committed tip', function () {
  this.timeout(30000);
  const fx = {};

  beforeEach(function () { setUp(fx); });
  afterEach(function () { return tearDown(fx); });

  it('does not serve the spent coin while the block that mined its spend is still being fetched', async function () {
    const { tracker } = fx;
    const { state, cb, block0, spend } = await syncedWithMempoolSpend(tracker);
    const x = cb.getId() + ':0';
    expect(outpoints(await tracker.getUtxosAddress(TEST_KEYS[0].address))).to.not.include(x);

    // The node mines T: its tip moves to block 1 and its mempool drops T.
    fx.release = holdBlocksFrom(tracker, state, 1);
    addBlockToState(state, makeBlock(1, block0.hash, [makeCoinbaseTx(2, 50 * SATOSHI), spend]));
    removeMempoolTx(state, spend.getId());
    await tracker.updateMempool();

    expect(await tracker.db.getLastBlockHeight()).to.equal(0, 'block 1 is not committed yet');
    expect(outpoints(await tracker.getUtxosAddress(TEST_KEYS[0].address))).to.not.include(x);
    expect(await tracker.mempoolDb.getTransaction('54' + spend.getId().substring(0, 16)), 'T kept').to.not.equal(null);

    // Once the block commits, its own cleanup removes T and X is spent on the confirmed side.
    fx.release();
    await waitForHeight(tracker, 1);
    expect(outpoints(await tracker.getUtxosAddress(TEST_KEYS[0].address))).to.not.include(x);
  });

  it('deletes an evicted tx once the committed tip is the node tip', async function () {
    const { tracker } = fx;
    const { state, cb } = await syncedWithMempoolSpend(tracker);
    clearMempool(state);
    await tracker.updateMempool();
    expect(outpoints(await tracker.getUtxosAddress(TEST_KEYS[0].address))).to.include(cb.getId() + ':0');
  });

  it('keeps every tx when the node reports the same height under a different hash', async function () {
    const { tracker } = fx;
    const { state, cb } = await syncedWithMempoolSpend(tracker);
    const info = tracker.connector.getBlockchainInfo;
    tracker.connector.getBlockchainInfo = async () => ({ ...(await info()), bestblockhash: 'f'.repeat(64) });
    clearMempool(state);
    try { await tracker.updateMempool(); } finally { tracker.connector.getBlockchainInfo = info; }
    expect(outpoints(await tracker.getUtxosAddress(TEST_KEYS[0].address))).to.not.include(cb.getId() + ':0');
  });

  it('keeps every tx and frees the mempool mutex when the tip read fails', async function () {
    const { tracker } = fx;
    const { state, cb } = await syncedWithMempoolSpend(tracker);
    const info = tracker.connector.getBlockchainInfo;
    tracker.connector.getBlockchainInfo = async () => { throw new Error('rpc down'); };
    clearMempool(state);
    try { await tracker.updateMempool(); } finally { tracker.connector.getBlockchainInfo = info; }
    expect(tracker.mempoolBusy).to.equal(false);
    expect(outpoints(await tracker.getUtxosAddress(TEST_KEYS[0].address))).to.not.include(cb.getId() + ':0');
  });
});
