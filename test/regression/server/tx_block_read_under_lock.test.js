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

// Regression: get_tx_block reads the tx row, its block and the committed tip
// pointers under the store-commit lock, so a block committed mid-read cannot
// label the row with a tip it was not read at.

const { expect } = require('chai');
const sinon = require('sinon');
const supertest = require('supertest');
const { createTestApp } = require('../../unit/api.test/support/test_app');
const {
  SATOSHI, makeCoinbaseTx, makeBlock,
  stubBlockchain, addBlockToState,
  waitForHeight, waitForSynced,
  createE2ETracker, patchLevelUpStoreInMemory
} = require('../../e2e/support/helpers');

let tracker;
let restoreLevelUp;
let release;

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

async function waitUntil(cond, what, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 5));
  }
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
  commits.holding = false;
}

async function getTxBlock(app, txid) {
  const res = await supertest(app).post('/')
    .send({ jsonrpc: '2.0', method: 'get_tx_block', params: { txid }, id: 1 })
    .expect(200);
  return res.body.result;
}

async function syncedChain() {
  const block0 = makeBlock(0, '0'.repeat(64), [makeCoinbaseTx(0, 50 * SATOSHI)]);
  const tx = makeCoinbaseTx(0, 50 * SATOSHI);
  const block1 = makeBlock(1, block0.hash, [tx]);
  const state = stubBlockchain(tracker, [block0, block1]);
  tracker.start();
  await waitForSynced(tracker);
  await waitUntil(() => tracker.mempoolReconverged && !tracker.mempoolBusy, 'the first mempool pass to finish');
  return { state, block1, txid: tx._txid };
}

describe('Regression: get_tx_block reads its row and its tip label under the store lock', function () {
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

  it('holds a block commit back until the tx row and its tip label are read', async function () {
    const { state, block1, txid } = await syncedChain();
    const app = createTestApp(tracker);
    expect((await getTxBlock(app, txid)).sync.committed_height).to.equal(1);

    const commits = watchCommits();
    const hold = holdStoreRead(tracker.db, 'getBlock');
    release = hold.release;
    const read = getTxBlock(app, txid);
    await hold.reached;

    addBlockToState(state, makeBlock(2, block1.hash, [makeCoinbaseTx(0, 50 * SATOSHI)]));
    await expectCommitHeldBehindReader(commits);
    release();

    const result = await read;
    expect(result.block_height).to.equal(1);
    expect(result.block_hash).to.equal(block1.hash);
    expect(result.sync.committed_height).to.equal(1);
    expect(result.sync.committed_hash).to.equal(block1.hash);
    expect(Object.keys(result).sort()).to.deep.equal(['block_hash', 'block_height', 'sync']);

    await waitForHeight(tracker, 2);
    expect((await getTxBlock(app, txid)).sync.committed_height).to.equal(2);
  });
});
