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

// A node running invalidateblock disconnects one block at a time, so a poll
// mid-disconnect reads a transient tip. When that transient tip sits inside the
// undo window and the final one is past it, acting on the first reading walks
// back the whole window and only then meets the refusal against the final tip.
// A tip below ours must settle (two agreeing readings) before any rollback.
const COMMITTED = 100669;
const WINDOW = 12;

// `tips` is the sequence of node tip readings; the last one repeats.
function build(tips) {
  const tracker = new XChainUtxoTracker(
    'bitcoin-regtest', '127.0.0.1', '18443', 'user', 'pass', 'test-db', false
  );
  const sleeps = [];
  tracker.sleep = async (ms) => { sleeps.push(ms); };
  let reads = 0;
  tracker.connector = {
    getBlockchainInfo: async () => ({ blocks: tips[Math.min(reads++, tips.length - 1)] })
  };
  const store = { top: COMMITTED, deletes: 0 };
  tracker.db = {
    getLastBlockHeight: async () => store.top,
    getLastBlockHash: async () => 'db' + store.top,
    getLastBlock: async () => ({ hash: 'db' + store.top, height: store.top })
  };
  tracker.loadLastBlocksSortedByHeight = async () => [];
  tracker.discardInflightBatchForReorg = async () => false;
  const verifyCalls = [];
  // Mirrors the walk's above-tip budget check: a gap past the window is
  // refused before any delete; one inside it deletes down to the node tip.
  tracker.verifyReorg = async (nodeTip) => {
    verifyCalls.push(nodeTip);
    if (store.top - nodeTip > WINDOW) {
      const err = new Error('node tip ' + nodeTip + ' is past the recovery window');
      err.tipBelowCommittedTip = true;
      throw err;
    }
    store.deletes += store.top - nodeTip;
    store.top = nodeTip;
    return true;
  };
  const sync = {
    lastProcessedBlockIndex: COMMITTED,
    lastProcessedBlockHash: 'db' + COMMITTED,
    tipBelowCommittedTipRefused: false,
    blocksQuantity: 0
  };
  return {
    tracker, sync, store, verifyCalls, sleeps,
    readCount: () => reads,
    setTips: (next) => { tips = next; reads = 0; }
  };
}

describe('tip-below rollback settles the node tip first @regression', function () {
  this.timeout(0);

  it('never walks back on a transient tip inside the window when the settled tip is past it', async function () {
    const { tracker, sync, store, verifyCalls } = build([COMMITTED - 12, COMMITTED - 15]);
    await refreshNodeTip.call(tracker, sync);

    expect(verifyCalls).to.not.include(COMMITTED - 12);
    expect(verifyCalls).to.deep.equal([COMMITTED - 15]);
    expect(store.deletes).to.equal(0);
    expect(store.top).to.equal(COMMITTED);
    expect(sync.tipBelowCommittedTipRefused).to.equal(true);
    expect(sync.lastProcessedBlockIndex).to.equal(COMMITTED);
    expect(tracker.blockchainInfoLastBlock).to.equal(COMMITTED - 15);
  });

  it('still rolls back onto a tip inside the window that holds still', async function () {
    const { tracker, sync, store, verifyCalls } = build([COMMITTED - 12]);
    await refreshNodeTip.call(tracker, sync);

    expect(verifyCalls).to.deep.equal([COMMITTED - 12]);
    expect(store.deletes).to.equal(12);
    expect(sync.lastProcessedBlockIndex).to.equal(COMMITTED - 12);
    expect(sync.tipBelowCommittedTipRefused).to.equal(false);
  });

  it('deletes nothing while the tip keeps moving, and ends the pass', async function () {
    let t = COMMITTED - 1;
    const tips = [];
    for (let i = 0; i < 20; i++) tips.push(t--);
    const { tracker, sync, store, verifyCalls } = build(tips);
    await refreshNodeTip.call(tracker, sync);

    expect(verifyCalls).to.deep.equal([]);
    expect(store.deletes).to.equal(0);
    expect(sync.lastProcessedBlockIndex).to.equal(COMMITTED);
  });

  it('does not roll back when the settled tip is back at the committed block', async function () {
    const { tracker, sync, store, verifyCalls } = build([COMMITTED - 5, COMMITTED]);
    await refreshNodeTip.call(tracker, sync);

    expect(verifyCalls).to.deep.equal([]);
    expect(store.deletes).to.equal(0);
  });

  it('does not walk back valid blocks while a refused tip climbs back through the undo window', async function () {
    const { tracker, sync, store, verifyCalls, setTips } = build([COMMITTED - 15]);
    await refreshNodeTip.call(tracker, sync);
    expect(sync.tipBelowCommittedTipRefused).to.equal(true);

    setTips([COMMITTED - 12]);
    await refreshNodeTip.call(tracker, sync);

    expect(verifyCalls).to.deep.equal([COMMITTED - 15]);
    expect(store.deletes).to.equal(0);
    expect(store.top).to.equal(COMMITTED);
    expect(sync.lastProcessedBlockIndex).to.equal(COMMITTED);
  });
});

describe('tip-below refusal counts the blocks it walked back @regression', function () {
  this.timeout(0);

  it('counts blocks a walk deleted before refusing in reorg_count', async function () {
    const { tracker, sync, store } = build([COMMITTED - 40]);
    tracker.verifyReorg = async () => {
      store.top = COMMITTED - 3;
      const err = new Error('refused with 3 block(s) already rolled back');
      err.tipBelowCommittedTip = true;
      throw err;
    };
    const before = tracker.reorgCount;
    await refreshNodeTip.call(tracker, sync);

    expect(tracker.reorgCount).to.equal(before + 1);
    expect(tracker.lastReorgDepth).to.equal(3);
  });

  it('does not count a refusal that deleted nothing', async function () {
    const { tracker, sync } = build([COMMITTED - 40]);
    const before = tracker.reorgCount;
    await refreshNodeTip.call(tracker, sync);

    expect(sync.tipBelowCommittedTipRefused).to.equal(true);
    expect(tracker.reorgCount).to.equal(before);
  });
});
