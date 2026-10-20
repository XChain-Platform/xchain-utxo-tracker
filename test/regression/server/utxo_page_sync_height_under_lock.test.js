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

// Regression: a get_utxos page reports the committed height its rows were read at.
//
// Paged reads are separate store snapshots, so a block committed between two
// pages can serve one coin twice: from the mempool on page 1 and as a confirmed
// row on a later page. A pager (the encoder) catches that by comparing each
// page's sync.tracker_height. That check is only sound when the height is read
// under the same store lock as the rows; read after the lock, a commit landing
// between the two makes page 1 claim the later height and the pages match.

const { expect } = require('chai');
const sinon = require('sinon');
const supertest = require('supertest');
const { createTestApp, createMockTracker } = require('../../unit/api.test/support/test_app');
const {
  SATOSHI, TEST_KEYS,
  makeCoinbaseTx, makeBlock,
  stubBlockchain, addBlockToState,
  waitForHeight, waitForSynced,
  createE2ETracker, patchLevelUpStoreInMemory
} = require('../../e2e/support/helpers');
const XChainUtxoTracker = require('../../../src/XChainUtxoTracker');
const { logger } = require('../../../src/XChainUtxoTracker/constants.js');

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

// Poll a condition every few milliseconds, and fail loudly at the deadline instead of carrying on.
async function waitUntil(cond, what, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 5));
  }
}

// The store-commit lock state the tracker keeps under a private symbol, or null when it has none.
function storeLockState(tracker) {
  const key = Object.getOwnPropertySymbols(tracker).find(s => s.description === 'storeCommitLock');
  return key ? tracker[key] : null;
}

// Flag any confirmed-store commit made while watch.holding is true.
function watchCommits(tracker) {
  const watch = { holding: true, committed: false };
  const endTransaction = tracker.db.endTransaction.bind(tracker.db);
  tracker.db.endTransaction = (...args) => {
    if (watch.holding && args[0] !== false) watch.committed = true;
    return endTransaction(...args);
  };
  return watch;
}

// Pause address reads at their mempool probe, after their confirmed rows; `reached` settles there.
function holdMempoolRead(tracker) {
  const gate = deferred();
  const reached = deferred();
  const readMempool = tracker.mempoolDb.getOutputsScriptPubKey.bind(tracker.mempoolDb);
  tracker.mempoolDb.getOutputsScriptPubKey = async (...args) => { reached.resolve(); await gate.promise; return readMempool(...args); };
  return { release: gate.resolve, reached: reached.promise };
}

// A page result as getUtxosAddress returns it: rows plus non-enumerable cursor and height.
function pageAt(height, cursor) {
  const rows = [{ txid: 'a'.repeat(64), vout: 0 }];
  Object.defineProperty(rows, 'nextCursor', { value: cursor, enumerable: false });
  Object.defineProperty(rows, 'committedHeight', { value: height, enumerable: false });
  return rows;
}

describe('Regression: get_utxos reports the height its rows were read at', function () {
  afterEach(function () { sinon.restore(); });

  it('JSON-RPC sync.tracker_height is the read height, not a height committed after it', async function () {
    const tracker = createMockTracker(sinon);
    tracker.getUtxosAddress.resolves(pageAt(7, 'abcd:0'));
    tracker.db.getLastBlockHeight.resolves(8);
    const app = createTestApp(tracker);
    const res = await supertest(app).post('/')
      .send({ jsonrpc: '2.0', method: 'get_utxos', params: { address: 'addr1', limit: 1 }, id: 1 })
      .expect(200);
    expect(res.body.result.nextCursor).to.equal('abcd:0');
    expect(res.body.result.sync.tracker_height).to.equal(7);
  });

  it('REST X-Tracker-Height is the read height, not a height committed after it', async function () {
    const tracker = createMockTracker(sinon);
    tracker.getUtxosAddress.resolves(pageAt(7, null));
    tracker.db.getLastBlockHeight.resolves(8);
    const app = createTestApp(tracker);
    const res = await supertest(app).get('/utxos/addr1').query({ limit: 1 });
    expect(res.headers['x-tracker-height']).to.equal('7');
  });
});

describe('Regression: get_utxos reads its height under the store lock', function () {
  this.timeout(30000);
  let tracker;
  let restoreLevelUp;
  let release;

  beforeEach(function () {
    restoreLevelUp = patchLevelUpStoreInMemory();
    tracker = createE2ETracker();
    release = null;
  });

  afterEach(async function () {
    if (release) release();
    sinon.restore();
    await tracker.stopParsing();
    restoreLevelUp();
  });

  it('keeps the pre-commit height when a block commits while the page is being read', async function () {
    const block0 = makeBlock(0, '0'.repeat(64), [makeCoinbaseTx(0, 50 * SATOSHI)]);
    const block1 = makeBlock(1, block0.hash, [makeCoinbaseTx(0, 50 * SATOSHI)]);
    const state = stubBlockchain(tracker, [block0, block1]);
    tracker.start();
    await waitForSynced(tracker);

    // Let the first mempool pass finish, so the block flush is the only writer that can queue on the lock.
    await waitUntil(() => tracker.mempoolReconverged && !tracker.mempoolBusy, 'the first mempool pass to finish');

    // Hold the page inside its read section, after its confirmed rows were read.
    const commits = watchCommits(tracker);
    const hold = holdMempoolRead(tracker);
    release = hold.release;
    const page = tracker.getUtxosAddress(TEST_KEYS[0].address, { limit: 1 });
    await hold.reached;
    const lock = storeLockState(tracker);
    expect(lock, 'the tracker keeps a store-commit lock').to.be.an('object');

    // The node mines block 2; its commit must queue behind the page instead of landing.
    addBlockToState(state, makeBlock(2, block1.hash, [makeCoinbaseTx(0, 50 * SATOSHI)]));
    await waitUntil(() => lock.writing || commits.committed, 'the block 2 commit to reach the store lock');
    expect(commits.committed, 'a commit landed while the page was being read').to.equal(false);
    expect(lock.readers).to.equal(1, 'the held page is the reader the commit waits on');
    expect(await tracker.db.getLastBlockHeight()).to.equal(1, 'the commit is held behind the reader');
    commits.holding = false;
    release();

    const rows = await page;
    expect(rows.committedHeight).to.equal(1);
    expect(rows.nextCursor).to.be.a('string');
    await waitForHeight(tracker, 2);
  });
});

// A reorg rollback moves the committed height a page reports, so it commits as the lock's writer.
describe('Regression: a reorg rollback commits under the store lock', function () {
  this.timeout(30000);
  let tracker;
  let restoreLevelUp;
  let held;

  beforeEach(function () {
    restoreLevelUp = patchLevelUpStoreInMemory();
    tracker = createE2ETracker();
    held = null;
  });

  afterEach(async function () {
    if (held) held.release();
    sinon.restore();
    await tracker.stopParsing();
    restoreLevelUp();
  });

  it('holds the rollback commit behind a get_utxos page and withdraws mempool readiness for the walk', async function () {
    const chain = buildChain(3);
    const state = stubBlockchain(tracker, chain);
    tracker.start();
    await waitForSynced(tracker);
    await waitUntil(() => tracker.isMempoolReconverged(), 'the first mempool pass');
    expect(mempoolReady(tracker), 'readiness before the reorg').to.equal(true);

    held = await holdPageBeforeListing(tracker);
    const rollback = sampleReadinessAtRollback(tracker, 1);
    const warn = sinon.spy(logger, 'warn');
    switchToLongerBranch(state, chain);
    await waitUntil(() => rollback.ready !== null, 'the rollback of block 2');
    await new Promise(r => setTimeout(r, 100));
    expect(await tracker.db.getLastBlockHeight()).to.equal(2, 'the rollback commit is held behind the reader');
    expect(rollback.ready, 'mempool readiness during the reorg walk').to.equal(false);
    expect(warn.calledWith('A reorg has been detected. Cleaning blocks...'), 'the prev-hash reorg path ran').to.equal(true);
    held.release();

    const rows = await held.page;
    expect(rows.committedHeight).to.equal(2);
    expect(rows.map(r => r.txid)).to.include(chain[2].transactions[0].getId());
    expect(rows).to.have.length(3);
    await waitForHeight(tracker, 3);
  });
});

// Starts a get_utxos page and holds it between its height read and its confirmed listing.
async function holdPageBeforeListing(tracker) {
  const gate = deferred();
  const listConfirmed = tracker.db.getOutputsScriptPubKey.bind(tracker.db);
  let paused = false;
  tracker.db.getOutputsScriptPubKey = async (...args) => {
    if (!paused) { paused = true; await gate.promise; }
    return listConfirmed(...args);
  };
  const page = tracker.getUtxosAddress(TEST_KEYS[0].address, { limit: 10 });
  await waitUntil(() => paused, 'the page to reach its listing');
  return { page, release: gate.resolve };
}

// Records mempool readiness when a rollback stages the tip pointer at `height`.
function sampleReadinessAtRollback(tracker, height) {
  const sample = { ready: null };
  const stageHeight = tracker.db.setLastBlockHeight.bind(tracker.db);
  tracker.db.setLastBlockHeight = async (h) => {
    if (h === height && sample.ready === null) sample.ready = mempoolReady(tracker);
    return stageHeight(h);
  };
  return sample;
}

// A coinbase-only chain paying TEST_KEYS[0], heights 0..count-1.
function buildChain(count) {
  const blocks = [];
  let prev = '0'.repeat(64);
  for (let h = 0; h < count; h++) {
    blocks.push(makeBlock(h, prev, [makeCoinbaseTx(0, 50 * SATOSHI)]));
    prev = blocks[h].hash;
  }
  return blocks;
}

// The node moves to a branch that replaces block 2 and is one block longer, so
// the next block's parent is not the tracker's tip (the prev-hash reorg path).
function switchToLongerBranch(state, chain) {
  const replaced = makeBlock(2, chain[1].hash, [makeCoinbaseTx(1, 50 * SATOSHI)]);
  const next = makeBlock(3, replaced.hash, [makeCoinbaseTx(1, 50 * SATOSHI)]);
  for (const b of [replaced, next]) state.hashToBlock.set(b.hash, b);
  state.blocks = [chain[0], chain[1], replaced, next];
}

// mempool_ready as get_utxos publishes it (X-Mempool-Ready, sync.mempool_ready).
function mempoolReady(tracker) {
  return XChainUtxoTracker.computeFreshness(0, 0, tracker.isSynced(),
    { mempoolReconverged: tracker.isMempoolReconverged() }).mempool_ready;
}
