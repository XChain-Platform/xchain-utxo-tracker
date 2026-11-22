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
const XChainUtxoTracker = require('../../src/XChainUtxoTracker');
const { refreshNodeTip } = require('../../src/XChainUtxoTracker/sync_loop_node_tip.js');

const H = 100;
const DELETED_TO = H - 12;

function build(walked = 0) {
  const tracker = new XChainUtxoTracker(
    'bitcoin-regtest', '127.0.0.1', '18443', 'user', 'pass', 'test-db', false
  );
  tracker.sleep = async () => {};
  let top = H;
  tracker.connector = {
    getBlockchainInfo: async () => ({ blocks: H - 40 })
  };
  tracker.db = {
    getLastBlockHeight: async () => top,
    getLastBlockHash: async () => 'db' + top,
    getLastBlock: async () => ({ hash: 'db' + top, height: top })
  };
  tracker.loadLastBlocksSortedByHeight = async () => [];
  tracker.discardInflightBatchForReorg = async () => false;
  // The walk deletes down to DELETED_TO, then refuses with the tagged error.
  tracker.verifyReorg = async () => {
    top = DELETED_TO;
    tracker.reorgRollbacksThisProcess = (tracker.reorgRollbacksThisProcess || 0) + walked;
    const err = new Error('node tip below committed tip with 12 block(s) already rolled back');
    err.tipBelowCommittedTip = true;
    throw err;
  };
  const sync = {
    lastProcessedBlockIndex: H,
    lastProcessedBlockHash: 'db' + H,
    tipBelowCommittedTipRefused: false,
    blocksQuantity: 0
  };
  return { tracker, sync };
}

function armed(walked) {
  const built = build(walked);
  built.tracker.mempoolReconverged = true;
  built.tracker.mempoolReadinessGen = 4;
  built.tracker.mempoolInterval = setInterval(() => {}, 1e6);
  built.passes = 0;
  built.tracker.updateMempool = async () => { built.passes++; };
  return built;
}

async function refuse(built) {
  try {
    await refreshNodeTip.call(built.tracker, built.sync);
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    clearInterval(built.tracker.mempoolInterval);
  }
}

// A tip-below walk can delete blocks and then refuse mid-walk (the node tip
// fell again while a hash fetch was failing). The refusal returns without a
// fatal error, so the in-memory cursor must be re-read from the store: if it
// keeps the pre-walk tip, restoring the node tip makes the loop compare equal
// hashes at the old height and idle "at tip" over the deleted range.
describe('rollBackToNodeTip refusal after deletes', function () {
  this.timeout(0);

  it('re-reads the cursor from the store after a refusal that followed deletes', async function () {
    const { tracker, sync } = build();
    await refreshNodeTip.call(tracker, sync);

    expect(sync.tipBelowCommittedTipRefused).to.equal(true);
    expect(sync.lastProcessedBlockIndex).to.equal(await tracker.db.getLastBlockHeight());
    expect(sync.lastProcessedBlockIndex).to.equal(DELETED_TO);
    expect(sync.lastProcessedBlockHash).to.equal('db' + DELETED_TO);
    expect(sync.lastBlockchainInfo).to.equal(null);
  });

  it('does not idle at tip once the node tip is restored to the old height', async function () {
    const { tracker, sync } = build();
    await refreshNodeTip.call(tracker, sync);
    // Node tip restored to H: the cursor must lag it, so the loop indexes
    // forward instead of taking the equal-height idle branch.
    expect(sync.lastProcessedBlockIndex).to.be.lessThan(H);
  });

  describe('mempool readiness', function () {
    it('withdraws readiness and runs a fresh pass after a refusal that followed deletes', async function () {
      const built = armed(1);
      await refuse(built);
      expect(built.tracker.mempoolReconverged).to.equal(false);
      expect(built.tracker.mempoolReadinessGen).to.equal(5);
      expect(built.passes).to.equal(1);
      expect(built.tracker.reorgCount).to.equal(1);
    });

    it('leaves readiness alone after a refusal that deleted nothing', async function () {
      const built = armed(0);
      await refuse(built);
      expect(built.tracker.mempoolReconverged).to.equal(true);
      expect(built.tracker.mempoolReadinessGen).to.equal(4);
      expect(built.passes).to.equal(0);
    });
  });
});

// Record the reorg counters at the moment the refusal sleep starts.
function observeSleep(built) {
  const seen = {};
  built.tracker.sleep = async () => {
    seen.at = {
      reorgCount: built.tracker.reorgCount,
      lastReorgDepth: built.tracker.lastReorgDepth
    };
  };
  return seen;
}

describe('rollBackToNodeTip refused-walk accounting order', function () {
  this.timeout(0);

  it('publishes a completed walk before entering the refusal sleep', async function () {
    const built = armed(3);
    const seen = observeSleep(built);
    await refuse(built);
    expect(seen.at).to.deep.equal({ reorgCount: 1, lastReorgDepth: 3 });
  });

  it('does not count a refusal that deleted no blocks', async function () {
    const built = armed(0);
    const seen = observeSleep(built);
    await refuse(built);
    expect(seen.at).to.deep.equal({ reorgCount: 0, lastReorgDepth: 0 });
  });
});
