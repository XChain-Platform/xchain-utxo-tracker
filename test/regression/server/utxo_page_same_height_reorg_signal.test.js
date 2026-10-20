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

// Regression: a REST get_utxos pager sees a same-height reorg between pages.
// A same-height tip swap leaves X-Tracker-Height unchanged on both pages, so the
// X-Tracker-Tip-Hash (and X-Reorg-Count) read under the rows' store lock tell the chains apart.

const { expect } = require('chai');
const sinon = require('sinon');
const supertest = require('supertest');
const { createTestApp, createMockTracker } = require('../../unit/api.test/support/test_app');
const {
  SATOSHI, TEST_KEYS,
  makeCoinbaseTx, makeBlock, buildCoinbaseChain,
  stubBlockchain, waitForSynced,
  createE2ETracker, patchLevelUpStoreInMemory
} = require('../../e2e/support/helpers');

// Poll an async condition every few milliseconds, and fail loudly at the deadline.
async function waitUntil(cond, what, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 10));
  }
}

// One REST page of the address's UTXOs, with the freshness headers a pager reads.
async function restPage(app, address, after) {
  const query = after ? { limit: 1, after } : { limit: 1 };
  const res = await supertest(app).get('/utxos/' + address).query(query).expect(200);
  expect(res.headers['x-reorg-count'], 'X-Reorg-Count on a get_utxos page').to.match(/^\d+$/);
  return {
    height: res.headers['x-tracker-height'],
    reorgCount: res.headers['x-reorg-count'],
    tipHash: res.headers['x-tracker-tip-hash'],
    cursor: res.headers['x-next-cursor']
  };
}

// The node replaces its tip at the same height and adds nothing above it.
function swapTipAtSameHeight(state, blocks) {
  const tip = blocks[blocks.length - 1];
  const replacement = makeBlock(tip.height, blocks[blocks.length - 2].hash, [makeCoinbaseTx(0, 50 * SATOSHI)]);
  state.hashToBlock.delete(tip.hash);
  state.blocks[blocks.length - 1] = replacement;
  state.hashToBlock.set(replacement.hash, replacement);
  return replacement;
}

// A page result as getUtxosAddress returns it: rows plus non-enumerable read-time fields.
function pageAt(height, reorgCount) {
  const rows = [{ txid: 'a'.repeat(64), vout: 0 }];
  Object.defineProperty(rows, 'nextCursor', { value: 'abcd:0', enumerable: false });
  Object.defineProperty(rows, 'committedHeight', { value: height, enumerable: false });
  Object.defineProperty(rows, 'reorgCount', { value: reorgCount, enumerable: false });
  return rows;
}

describe('Regression: get_utxos reports the reorg count its rows were read at', function () {
  afterEach(function () { sinon.restore(); });

  it('REST X-Reorg-Count is the count read with the rows, not a later one', async function () {
    const tracker = createMockTracker(sinon);
    tracker.reorgCount = 3;
    tracker.getUtxosAddress.resolves(pageAt(7, 2));
    const res = await supertest(createTestApp(tracker)).get('/utxos/addr1').query({ limit: 1 }).expect(200);
    expect(res.headers['x-reorg-count']).to.equal('2');
  });

  it('JSON-RPC sync.reorg_count is the count read with the rows, not a later one', async function () {
    const tracker = createMockTracker(sinon);
    tracker.reorgCount = 3;
    tracker.getUtxosAddress.resolves(pageAt(7, 2));
    const res = await supertest(createTestApp(tracker)).post('/')
      .send({ jsonrpc: '2.0', method: 'get_utxos', params: { address: 'addr1', limit: 1 }, id: 1 })
      .expect(200);
    expect(res.body.result.sync.reorg_count).to.equal(2);
  });
});

// Gives each test a fresh in-memory e2e tracker, stopped afterwards; returns a getter for it.
function useE2ETracker() {
  const ctx = {};
  beforeEach(function () {
    ctx.restoreLevelUp = patchLevelUpStoreInMemory();
    ctx.tracker = createE2ETracker();
  });
  afterEach(async function () {
    sinon.restore();
    await ctx.tracker.stopParsing();
    ctx.restoreLevelUp();
  });
  return () => ctx.tracker;
}

// Syncs the tracker onto a 5-block chain and serves it over the real app stack.
async function servedChain(tracker) {
  const blocks = buildCoinbaseChain(5, 0);
  const state = stubBlockchain(tracker, blocks);
  tracker.start();
  await waitForSynced(tracker);
  return { blocks, state, app: createTestApp(tracker), address: TEST_KEYS[0].address };
}

describe('Regression: a REST pager sees a same-height reorg between pages', function () {
  this.timeout(30000);
  const currentTracker = useE2ETracker();

  it('moves X-Reorg-Count across a same-height tip swap while X-Tracker-Height stays put', async function () {
    const tracker = currentTracker();
    const { blocks, state, app, address } = await servedChain(tracker);

    // Control: with no reorg between them, two pages agree on both signals.
    const first = await restPage(app, address);
    const unchanged = await restPage(app, address, first.cursor);
    expect(unchanged.height).to.equal('4');
    expect(unchanged.reorgCount, 'no reorg ran between the pages').to.equal(first.reorgCount);

    // The node swaps block 4 for a different block 4, and the tracker rolls onto it.
    const replacement = swapTipAtSameHeight(state, blocks);
    await waitUntil(async () => (await tracker.db.getLastBlockHash()) === replacement.hash, 'the replacement tip');

    const after = await restPage(app, address, first.cursor);
    expect(after.height, 'height alone cannot tell the two chains apart').to.equal(first.height);
    expect(after.reorgCount, 'the same-height reorg moves the count').to.not.equal(first.reorgCount);
  });

  it('moves X-Tracker-Tip-Hash across a same-height tip swap the reorg count does not show', async function () {
    const tracker = currentTracker();
    const { blocks, state, app, address } = await servedChain(tracker);

    // Control: with no reorg between them, two pages name the same tip.
    const first = await restPage(app, address);
    expect(first.tipHash, 'page 1 names the tip it was read on').to.equal(blocks[blocks.length - 1].hash);
    expect(first.reorgCount, 'no reorg has run in this process yet').to.equal('0');
    const unchanged = await restPage(app, address, first.cursor);
    expect(unchanged.tipHash, 'no reorg ran between the pages').to.equal(first.tipHash);

    const replacement = swapTipAtSameHeight(state, blocks);
    await waitUntil(async () => (await tracker.db.getLastBlockHash()) === replacement.hash, 'the replacement tip');
    // Reset the counters as a restart's initStatusCounters does, so the count cannot show the swap.
    tracker.reorgCount = 0;
    tracker.lastReorgDepth = 0;

    const after = await restPage(app, address, first.cursor);
    expect(after.height, 'height alone cannot tell the two chains apart').to.equal(first.height);
    expect(after.reorgCount, 'the reset count matches page 1').to.equal(first.reorgCount);
    expect(after.tipHash, 'the tip hash names the replacement chain').to.equal(replacement.hash);
    expect(after.tipHash).to.not.equal(first.tipHash);
  });
});

describe('Regression: get_utxos names the chain tip its rows were read on', function () {
  afterEach(function () { sinon.restore(); });

  it('sends the tip hash read with the rows on REST and JSON-RPC, and omits it when absent', async function () {
    const tracker = createMockTracker(sinon);
    const page = pageAt(7, 2);
    Object.defineProperty(page, 'committedHash', { value: 'c'.repeat(64), enumerable: false });
    tracker.getUtxosAddress.resolves(page);
    const app = createTestApp(tracker);
    const rest = await supertest(app).get('/utxos/addr1').query({ limit: 1 }).expect(200);
    expect(rest.headers['x-tracker-tip-hash']).to.equal('c'.repeat(64));
    expect(rest.body, 'the body stays a bare UTXO list').to.deep.equal([{ txid: 'a'.repeat(64), vout: 0 }]);
    const rpc = await supertest(app).post('/')
      .send({ jsonrpc: '2.0', method: 'get_utxos', params: { address: 'addr1', limit: 1 }, id: 1 })
      .expect(200);
    expect(rpc.body.result.sync.committed_hash).to.equal('c'.repeat(64));

    // A page without a read-time hash (an older store, an empty one) sends neither field.
    tracker.getUtxosAddress.resolves(pageAt(7, 2));
    const bare = await supertest(app).get('/utxos/addr1').query({ limit: 1 }).expect(200);
    expect(bare.headers).to.not.have.property('x-tracker-tip-hash');
  });
});
