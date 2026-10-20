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

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
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

    // Hold the page inside its read section, after its confirmed rows were read.
    const gate = deferred();
    release = gate.resolve;
    const readMempool = tracker.mempoolDb.getOutputsScriptPubKey.bind(tracker.mempoolDb);
    let paused = false;
    tracker.mempoolDb.getOutputsScriptPubKey = async (...args) => { paused = true; await gate.promise; return readMempool(...args); };
    const page = tracker.getUtxosAddress(TEST_KEYS[0].address, { limit: 1 });
    while (!paused) await new Promise(r => setTimeout(r, 5));

    // The node mines block 2; its commit must wait for the page to finish.
    addBlockToState(state, makeBlock(2, block1.hash, [makeCoinbaseTx(0, 50 * SATOSHI)]));
    await new Promise(r => setTimeout(r, 100));
    expect(await tracker.db.getLastBlockHeight()).to.equal(1, 'the commit is held behind the reader');
    release();

    const rows = await page;
    expect(rows.committedHeight).to.equal(1);
    expect(rows.nextCursor).to.be.a('string');
    await waitForHeight(tracker, 2);
  });
});
