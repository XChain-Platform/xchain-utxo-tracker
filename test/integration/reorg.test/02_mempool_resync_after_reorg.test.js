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


// The mempool half of ../reorg.test.js: what a tip-replacing reorg owes the
// mempool store once the rollback is done.

const { expect } = require('chai');
const sinon = require('sinon');
const {
  SATOSHI, makeCoinbaseTx, makeBlock, processBlocksAndCommit,
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

async function createChain(length) {
  const blocks = [];
  let prevHash = '0'.repeat(64);

  for (let i = 0; i < length; i++) {
    const block = makeBlock(i, prevHash, [makeCoinbaseTx(0, 10 * SATOSHI)]);
    blocks.push(block);
    prevHash = block.hash;
  }

  await processBlocksAndCommit(tracker, blocks);
  return blocks;
}

// A reorg returns the orphaned blocks' spends to the node mempool. The mempool
// pass must run right after the rollback, not at the next interval tick, and
// readiness must drop until it finishes.
describe('Integration: mempool resync after a tip-replacing reorg', function () {
  useTracker();

  const { pollAtTipOrIndex, refreshNodeTip } = require('../../../src/XChainUtxoTracker/sync_loop_node_tip.js');

  async function arrange() {
    const blocks = await createChain(3);
    const tip = blocks[2];
    tracker.blockchainInfoLastBlock = tip.height;
    tracker.mempoolInterval = setInterval(() => {}, 1e9); // poller already started
    tracker.mempoolReconverged = true;
    tracker.sleep = async () => {};
    let passDone = false;
    const updateMempool = sinon.stub(tracker, 'updateMempool').callsFake(async () => {
      await new Promise(r => setTimeout(r, 20));
      passDone = true;
      tracker.mempoolReconverged = true;
    });
    sinon.stub(tracker.connector, 'getBlockHash').resolves(randHash());
    sinon.stub(tracker, 'verifyReorg').resolves(true);
    const sync = {
      lastProcessedBlockIndex: tip.height, lastProcessedBlockHash: tip.hash,
      blocksQuantity: 0, blocksCount: 0, transactionsCount: 0, inputsCount: 0,
      outputsCount: 0, prefetchQueue: [], pendingMempoolTxCleanup: [], blockTimestamps: []
    };
    return { sync, updateMempool, isDone: () => passDone };
  }

  afterEach(function () { clearInterval(tracker.mempoolInterval); });

  it('same-height tip swap runs a mempool pass and drops readiness until it ends', async function () {
    const { sync, updateMempool, isDone } = await arrange();
    const after = await pollAtTipOrIndex.call(tracker, sync);
    if (typeof after === 'function') after();
    expect(tracker.mempoolReconverged).to.equal(false);
    await new Promise(r => setTimeout(r, 150));
    expect(updateMempool.callCount).to.equal(1);
    expect(isDone()).to.equal(true);
    expect(tracker.mempoolReconverged).to.equal(true);
  });

  it('tip-below rollback runs a mempool pass and drops readiness until it ends', async function () {
    const { sync, updateMempool } = await arrange();
    const tipBelow = sync.lastProcessedBlockIndex - 1;
    sinon.stub(tracker.connector, 'getBlockchainInfo').resolves({ blocks: tipBelow });
    const nodeTipHash = randHash();
    sinon.stub(tracker.db, 'getLastBlock').resolves({ height: sync.lastProcessedBlockIndex, hash: sync.lastProcessedBlockHash });
    sinon.stub(tracker, 'loadLastBlocksSortedByHeight').resolves([]);
    sinon.stub(tracker.db, 'getLastBlockHeight').resolves(tipBelow);
    sinon.stub(tracker.db, 'getLastBlockHash').resolves(nodeTipHash);
    sync.lastBlockchainInfo = null;
    await refreshNodeTip.call(tracker, sync);
    expect(tracker.mempoolReconverged).to.equal(false);
    await new Promise(r => setTimeout(r, 150));
    expect(updateMempool.callCount).to.equal(1);
  });
});
