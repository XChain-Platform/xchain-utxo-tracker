'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
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
const { logger } = require('../../src/XChainUtxoTracker/constants.js');

// The committed tip the fake store holds, and the tip the fake node reports,
// which each test moves to stage a refusal or a recovery.
const COMMITTED = 100;
let nodeTip;

// A tracker whose node, store and reorg walk are fakes: the walk always
// refuses with the tagged tip-below error, so only the latch logic is real.
function newTracker() {
  const tracker = new XChainUtxoTracker('bitcoin-regtest', '127.0.0.1', '18443', 'user', 'pass', 'test-db', false);
  tracker.sleep = async () => {};
  tracker.connector = {
    getBlockchainInfo: async () => ({ blocks: nodeTip }),
    getBlockHash: async () => 'h' + COMMITTED
  };
  tracker.discardInflightBatchForReorg = async () => false;
  tracker.loadLastBlocksSortedByHeight = async () => [];
  // The refusal path re-reads the committed cursor; nothing is deleted here,
  // so the store still holds the committed tip.
  tracker.db = {
    getLastBlock: async () => ({ hash: 'h' + COMMITTED, height: COMMITTED }),
    getLastBlockHeight: async () => COMMITTED,
    getLastBlockHash: async () => 'h' + COMMITTED
  };
  tracker.verifyReorg = async () => {
    const e = new Error('verifyReorg: refused, below the recovery window');
    e.tipBelowCommittedTip = true;
    throw e;
  };
  return tracker;
}

// A sync cursor sitting on the committed tip with no cached node reading.
function newSync() {
  return { lastProcessedBlockIndex: COMMITTED, lastProcessedBlockHash: 'h' + COMMITTED, lastBlockchainInfo: null, lastBlockchainInfoRefreshAt: 0 };
}

// The tip-below refusal is logged once per event. The latch that dedupes it
// must drop when the node tip recovers by itself, or every later event is
// silent at warn and error level.
describe('XChainUtxoTracker: tip-below refusal latch ends with the event', function () {
  this.timeout(0);
  let warns, errors, origWarn, origError, origInfo;

  beforeEach(function () {
    warns = []; errors = [];
    origWarn = logger.warn; origError = logger.error; origInfo = logger.info;
    logger.warn = (m) => warns.push(m);
    logger.error = (m) => errors.push(m);
    logger.info = () => {};
  });
  afterEach(function () {
    logger.warn = origWarn; logger.error = origError; logger.info = origInfo;
  });

  it('logs again on a second event after the node tip recovered by itself', async function () {
    const tracker = newTracker();
    const sync = newSync();

    nodeTip = COMMITTED - 15;
    await refreshNodeTip.call(tracker, sync);
    expect(warns.length).to.equal(1);
    expect(errors.length).to.equal(1);
    expect(sync.tipBelowCommittedTipRefused).to.equal(true);

    nodeTip = COMMITTED; // recovers on its own; the tracker stays at its tip
    tracker.mempoolInterval = 1; // already started; nothing to spawn
    await refreshNodeTip.call(tracker, sync);
    expect(sync.tipBelowCommittedTipRefused).to.equal(false);

    nodeTip = COMMITTED - 15;
    await refreshNodeTip.call(tracker, sync);
    expect(warns.length).to.equal(2);
    expect(errors.length).to.equal(2);
  });

  it('still logs only once for consecutive refusals with no recovery between', async function () {
    const tracker = newTracker();
    const sync = newSync();
    nodeTip = COMMITTED - 15;
    await refreshNodeTip.call(tracker, sync);
    await refreshNodeTip.call(tracker, sync);
    await refreshNodeTip.call(tracker, sync);
    expect(warns.length).to.equal(1);
    expect(errors.length).to.equal(1);
  });
});
