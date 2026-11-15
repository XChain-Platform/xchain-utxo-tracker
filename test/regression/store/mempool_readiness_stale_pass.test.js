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

// Regression: a mempool pass that started before readiness was withdrawn (the
// tracker fell behind the node, a reorg rolled the tip back, the loop halted or
// stopped) listed the node mempool before that event, so its store misses what
// the event changed. It must not assert readiness when it ends; only a pass that
// started after the withdrawal may.

const { expect } = require('chai');
const sinon = require('sinon');
const crypto = require('crypto');
const XChainUtxoTracker = require('../../../src/XChainUtxoTracker');
const LevelUpStore = require('../../../src/store/level_up_db');
const { indexNextBlock, resyncMempoolAfterReorg } = require('../../../src/XChainUtxoTracker/sync_loop_block_apply.js');
const { refreshNodeTip } = require('../../../src/XChainUtxoTracker/sync_loop_node_tip.js');

let tracker;
let db;
let mempoolDb;
let release;

const randTxid = () => crypto.randomBytes(32).toString('hex');

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

async function waitUntil(cond, what, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 5));
  }
}

async function setUp() {
  tracker = new XChainUtxoTracker('bitcoin-regtest', '127.0.0.1', '18443', 'user', 'pass', 'test-db', false);
  db = new LevelUpStore('tracker-stale-' + Date.now(), true);
  mempoolDb = new LevelUpStore('mempool-stale-' + Date.now(), true);
  await db.createDatabase();
  await mempoolDb.createDatabase();
  tracker.db = db;
  tracker.mempoolDb = mempoolDb;
  tracker.sleep = async () => {};
  sinon.stub(tracker.connector, 'getBlockchainInfo').rejects(new Error('no node in unit tests'));
  sinon.stub(tracker.connector, 'getRawMempool').resolves([randTxid(), randTxid()]);
}

// The first batch fetch waits on a gate, so the pass is held in flight; later fetches answer at once.
function holdFirstPass() {
  const gate = deferred();
  const reached = deferred();
  let held = false;
  sinon.stub(tracker.connector, 'getRawTransactions').callsFake(async (chunk) => {
    if (!held) { held = true; reached.resolve(); await gate.promise; }
    return chunk.map(() => null);
  });
  release = gate.resolve;
  return reached.promise;
}

function blockSync() {
  return { lastProcessedBlockIndex: 0, lastProcessedBlockHash: '0'.repeat(64), prefetchQueue: [],
    blockFetchFailures: 0, blockFetchFailureHeight: null, auxPowParseFailures: 0, auxPowParseFailureHeight: null,
    pendingMempoolTxCleanup: [], blockTimestamps: [], _t: {} };
}

// Falls behind the node the way the sync loop does, with no block to apply.
async function fallBehindNode() {
  tracker.blockchainInfoLastBlock = 1000;
  sinon.stub(tracker.connector, 'getBlocksBatch').resolves([]);
  await indexNextBlock.call(tracker, blockSync());
}

const SUITE_TITLE = 'Regression: a mempool pass older than a readiness withdrawal never asserts readiness';

function useTrackerFixture() {
  beforeEach(async function () {
    release = null;
    await setUp();
  });

  afterEach(async function () {
    if (release) release();
    clearInterval(tracker.mempoolInterval);
    sinon.restore();
    try { await db.close(); } catch (e) {}
    try { await mempoolDb.close(); } catch (e) {}
  });
}

describe(SUITE_TITLE, function () {
  this.timeout(30000);
  useTrackerFixture();

  it('a pass in flight when the tracker falls behind the node leaves readiness false', async function () {
    tracker.mempoolInterval = setInterval(() => {}, 1e9);
    const reached = holdFirstPass();
    const stale = tracker.updateMempool();
    await reached;

    await fallBehindNode();
    release();
    await stale;

    expect(tracker.mempoolBusy).to.equal(false);
    expect(tracker.mempoolReconverged, 'the stale pass asserted readiness').to.equal(false);
    expect(tracker.mempoolInterval).to.equal(null);

    await tracker.updateMempool();
    expect(tracker.mempoolReconverged, 'a pass started after the withdrawal asserts it').to.equal(true);
  });

  it('a pass in flight when a reorg resyncs the mempool leaves readiness false until the fresh pass ends', async function () {
    tracker.mempoolInterval = setInterval(() => {}, 1e9);
    const reached = holdFirstPass();
    const stale = tracker.updateMempool();
    await reached;

    resyncMempoolAfterReorg.call(tracker);
    release();
    await stale;
    expect(tracker.mempoolReconverged, 'the stale pass asserted readiness').to.equal(false);

    await waitUntil(() => tracker.mempoolReconverged && !tracker.mempoolBusy, 'the post-reorg pass to finish');
    expect(tracker.connector.getRawMempool.callCount).to.equal(2);
  });

});

describe(SUITE_TITLE, function () {
  this.timeout(30000);
  useTrackerFixture();

  it('a pass in flight when the loop halts leaves readiness false', async function () {
    const reached = holdFirstPass();
    const stale = tracker.updateMempool();
    await reached;

    tracker.enterHaltedState({ reason: 'deep reorg', at: 'now', height: 5 });
    release();
    await stale;

    expect(tracker.mempoolReconverged, 'the stale pass asserted readiness').to.equal(false);
  });

  it('a pass in flight when the node tip goes stale leaves readiness false', async function () {
    const reached = holdFirstPass();
    const stale = tracker.updateMempool();
    await reached;

    tracker.lastNodeRpcOkAt = 0;
    await refreshNodeTip.call(tracker, { lastBlockchainInfo: null });
    release();
    await stale;

    expect(tracker.mempoolReconverged, 'the stale pass asserted readiness').to.equal(false);
  });

  it('a pass with no withdrawal while it runs still asserts readiness', async function () {
    const reached = holdFirstPass();
    const pass = tracker.updateMempool();
    await reached;
    release();
    await pass;

    expect(tracker.mempoolReconverged).to.equal(true);
    expect(tracker.mempoolBusy).to.equal(false);
  });
});
