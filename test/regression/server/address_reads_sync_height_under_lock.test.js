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

// Regression: get_info, get_balance and get_first_seen_status (and /info, /balance,
// /firstseen) report the committed height, tip hash and reorg count their rows were
// read at, as get_utxos does. Read after the store lock, a block committed between
// the rows and the label marks a pre-commit body as current at the new height.

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

const READ_HASH = 'b'.repeat(64);

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

// Attach a read snapshot the way the tracker does: non-enumerable, so bodies keep their shape.
function readAt(target, height) {
  Object.defineProperty(target, 'committedHeight', { value: height, enumerable: false });
  Object.defineProperty(target, 'committedHash', { value: READ_HASH, enumerable: false });
  Object.defineProperty(target, 'reorgCount', { value: 3, enumerable: false });
  Object.defineProperty(target, 'mempoolEpoch', { value: 12, enumerable: false });
  Object.defineProperty(target, 'mempoolReconverged', { value: false, enumerable: false });
  return target;
}

function infoAt(height) {
  return readAt({ address: 'addr1', balances: { confirmed: '1', pending: '0', received: '1' },
    utxos: { confirmed: 1, pending: 0 } }, height);
}

// A tracker whose rows were read at 7 while the live committed height is already 8.
function trackerReadAtSevenLiveEight() {
  const tracker = createMockTracker(sinon);
  tracker.db.getLastBlockHeight.resolves(8);
  tracker.reorgCount = 4;
  tracker.getBalanceInfo.resolves(infoAt(7));
  tracker.getUtxosAddress.resolves(readAt([{ txid: 'a'.repeat(64), vout: 0, value: '150000000' }], 7));
  tracker.getFirstSeenAt = sinon.stub().resolves({ firstSeen: null, committedHeight: 7, committedHash: READ_HASH,
    reorgCount: 3, mempoolEpoch: 12, mempoolReconverged: false });
  return tracker;
}

// The production balance reader, not the test harness's injected one.
const productionApp = (tracker) => createTestApp(tracker, '', { getBalance: undefined });

async function rpc(app, method) {
  const res = await supertest(app).post('/')
    .send({ jsonrpc: '2.0', method, params: { address: 'addr1' }, id: 1 })
    .expect(200);
  return res.body.result;
}

function expectReadSync(sync) {
  expect(sync.tracker_height).to.equal(7);
  expect(sync.committed_hash).to.equal(READ_HASH);
  expect(sync.reorg_count).to.equal(3);
  expect(sync.mempool_epoch).to.equal(12);
  expect(sync.mempool_ready).to.equal(false);
}

function expectReadHeaders(res) {
  expect(res.headers['x-tracker-height']).to.equal('7');
  expect(res.headers['x-tracker-tip-hash']).to.equal(READ_HASH);
  expect(res.headers['x-reorg-count']).to.equal('3');
  expect(res.headers['x-mempool-epoch']).to.equal('12');
}

describe('Regression: address reads report the snapshot their rows were read at', function () {
  afterEach(function () { sinon.restore(); });

  it('get_info sync is the read snapshot and the body gains no new keys', async function () {
    const result = await rpc(productionApp(trackerReadAtSevenLiveEight()), 'get_info');
    expectReadSync(result.sync);
    expect(Object.keys(result).sort()).to.deep.equal(['address', 'balances', 'sync', 'utxos']);
  });

  it('get_balance sync is the read snapshot and balance stays a decimal string', async function () {
    const result = await rpc(productionApp(trackerReadAtSevenLiveEight()), 'get_balance');
    expect(result.balance).to.equal('1.50000000');
    expectReadSync(result.sync);
  });

  it('get_first_seen_status labels a null with the height it was read at', async function () {
    const result = await rpc(productionApp(trackerReadAtSevenLiveEight()), 'get_first_seen_status');
    expect(result.first_seen).to.equal(null);
    expectReadSync(result.sync);
  });

  it('REST /info headers and sync field are the read snapshot', async function () {
    const res = await supertest(productionApp(trackerReadAtSevenLiveEight())).get('/info/addr1').expect(200);
    expectReadHeaders(res);
    expectReadSync(res.body.sync);
  });

  it('REST /balance headers are the read snapshot and the body stays the bare string', async function () {
    const res = await supertest(productionApp(trackerReadAtSevenLiveEight())).get('/balance/addr1').expect(200);
    expectReadHeaders(res);
    expect(res.text).to.equal('1.50000000');
  });

  it('REST /firstseen headers are the read snapshot and the body stays bare', async function () {
    const res = await supertest(productionApp(trackerReadAtSevenLiveEight())).get('/firstseen/addr1').expect(200);
    expectReadHeaders(res);
    expect(res.body).to.equal(null);
  });

  it('an injected balance reader returning a bare value still answers, from the live height', async function () {
    const tracker = trackerReadAtSevenLiveEight();
    const app = createTestApp(tracker, '', { getBalance: async () => '2.5' });
    const result = await rpc(app, 'get_balance');
    expect(result.balance).to.equal('2.5');
    expect(result.sync.tracker_height).to.equal(8);
  });
});

let tracker;
let restoreLevelUp;
let release;

// A synced two-block chain paying TEST_KEYS[0], with the first mempool pass finished.
async function syncedChain() {
  const block0 = makeBlock(0, '0'.repeat(64), [makeCoinbaseTx(0, 50 * SATOSHI)]);
  const block1 = makeBlock(1, block0.hash, [makeCoinbaseTx(0, 50 * SATOSHI)]);
  const state = stubBlockchain(tracker, [block0, block1]);
  tracker.start();
  await waitForSynced(tracker);
  await waitUntil(() => tracker.mempoolReconverged && !tracker.mempoolBusy, 'the first mempool pass to finish');
  return { state, block1 };
}

// Flag any confirmed-store commit made while watch.holding is true.
function watchCommits() {
  const watch = { holding: true, committed: false };
  const endTransaction = tracker.db.endTransaction.bind(tracker.db);
  tracker.db.endTransaction = (...args) => {
    if (watch.holding && args[0] !== false) watch.committed = true;
    return endTransaction(...args);
  };
  return watch;
}

// Wait for the next block's commit to queue on the store lock, and prove it did not land.
async function expectCommitHeldBehindReader(commits) {
  const key = Object.getOwnPropertySymbols(tracker).find(s => s.description === 'storeCommitLock');
  const lock = tracker[key];
  await waitUntil(() => lock.writing || commits.committed, 'the block 2 commit to reach the store lock');
  expect(commits.committed, 'a commit landed while the read was in progress').to.equal(false);
  expect(lock.readers).to.equal(1, 'the held read is the reader the commit waits on');
  expect(await tracker.db.getLastBlockHeight()).to.equal(1, 'the commit is held behind the reader');
  commits.holding = false;
}

// Pause the next call of target[method] until released; `reached` settles when it is entered.
function holdStoreRead(target, method) {
  const gate = deferred();
  const reached = deferred();
  const original = target[method].bind(target);
  let held = false;
  target[method] = async (...args) => {
    if (!held) { held = true; reached.resolve(); await gate.promise; }
    return original(...args);
  };
  return { release: gate.resolve, reached: reached.promise };
}

async function getInfoKeepsPreCommitSnapshot() {
  const { state, block1 } = await syncedChain();
  const commits = watchCommits();
  const hold = holdStoreRead(tracker.mempoolDb, 'getOutputsScriptPubKey');
  release = hold.release;
  const read = tracker.getBalanceInfo(TEST_KEYS[0].address);
  await hold.reached;

  addBlockToState(state, makeBlock(2, block1.hash, [makeCoinbaseTx(0, 50 * SATOSHI)]));
  await expectCommitHeldBehindReader(commits);
  release();

  const info = await read;
  expect(info.committedHeight).to.equal(1);
  expect(info.committedHash).to.equal(block1.hash);
  expect(Object.keys(info)).to.not.include('committedHeight');
  await waitForHeight(tracker, 2);
}

async function firstSeenReadsNextBlockAsNull() {
  const { state, block1 } = await syncedChain();
  const commits = watchCommits();
  const hold = holdStoreRead(tracker.db, 'getOutputScriptBlock');
  release = hold.release;
  const read = tracker.getFirstSeenAt(TEST_KEYS[1].address);
  await hold.reached;

  addBlockToState(state, makeBlock(2, block1.hash, [makeCoinbaseTx(1, 50 * SATOSHI)]));
  await expectCommitHeldBehindReader(commits);
  release();

  const first = await read;
  expect(first.firstSeen).to.equal(null);
  expect(first.committedHeight).to.equal(1);
  await waitForHeight(tracker, 2);
  const after = await tracker.getFirstSeenAt(TEST_KEYS[1].address);
  expect(after.firstSeen).to.deep.equal({ height: 2 });
  expect(after.committedHeight).to.equal(2);
  expect(await tracker.getFirstSeen(TEST_KEYS[1].address)).to.deep.equal({ height: 2 });
}

describe('Regression: get_info and first-seen read their snapshot under the store lock', function () {
  this.timeout(30000);

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

  it('get_info keeps the pre-commit snapshot when a block commits mid-read', getInfoKeepsPreCommitSnapshot);

  it('first-seen reads an address first paid in the next block as null at the pre-commit height', firstSeenReadsNextBlockAsNull);
});
