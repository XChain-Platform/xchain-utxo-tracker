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

//  (review finding P18): the mempool write transaction must NOT span the
// whole multi-batch fetch/sleep loop. The old code opened one
// beginTransaction() before the loop and committed a single endTransaction()
// only after every batch had been fetched and every inter-batch sleep had
// elapsed, so on a large mempool the write path stayed uncommitted for tens of
// seconds and pending-balance reads saw the previous pass's stale snapshot the
// whole time. These tests pin the fix: RPC fetches and inter-batch sleeps run
// with NO open transaction, and each batch commits independently.

const { expect } = require('chai');
const sinon = require('sinon');
const crypto = require('crypto');
const XChainUtxoTracker = require('../../src/XChainUtxoTracker');
const LevelUpStore = require('../../src/LevelUpDb');

// MEMPOOL_BATCH_SIZE is 1000 in the source; use enough txids to force several
// batches (and therefore several inter-batch sleeps) so the "spans the whole
// loop" regression would be observable.
const TXID_COUNT = 2500;

function randTxid() { return crypto.randomBytes(32).toString('hex'); }

// The mempool DB's open-transaction state is exactly `transactionArray != null`
// (beginTransaction sets a fresh Map, endTransaction nulls it).
function hasOpenTransaction(db) { return db.transactionArray != null; }

describe('updateMempool transaction scope ( / P18)', function () {
  let tracker;
  let db;
  let mempoolDb;

  beforeEach(async function () {
    tracker = new XChainUtxoTracker(
      'bitcoin-regtest', '127.0.0.1', '18443', 'user', 'pass', 'test-db', false
    );

    db = new LevelUpStore('tracker-scope-' + Date.now(), true);
    mempoolDb = new LevelUpStore('mempool-scope-' + Date.now(), true);
    await db.createDatabase();
    await mempoolDb.createDatabase();
    tracker.db = db;
    tracker.mempoolDb = mempoolDb;
    tracker.blockchainInfoLastBlock = 1000;
  });

  afterEach(async function () {
    sinon.restore();
    try { await db.close(); } catch (e) {}
    try { await mempoolDb.close(); } catch (e) {}
  });

  it('never holds an open mempool transaction during RPC fetch or inter-batch sleep', async function () {
    const txids = [];
    for (let i = 0; i < TXID_COUNT; i++) txids.push(randTxid());

    // Node returns a large mempool. getRawTransactions returns all-null hex so
    // parseTransaction is skipped: this test isolates transaction SCOPE, not
    // parse correctness (covered by the integration/e2e mempool suites).
    sinon.stub(tracker.connector, 'getRawMempool').resolves(txids.slice());

    const fetchOpenStates = [];
    sinon.stub(tracker.connector, 'getRawTransactions').callsFake(async (chunk) => {
      // At the moment the RPC is issued there must be NO open write transaction.
      fetchOpenStates.push(hasOpenTransaction(mempoolDb));
      return chunk.map(() => null);
    });

    const sleepOpenStates = [];
    sinon.stub(tracker, 'sleep').callsFake(async () => {
      // The inter-batch throttle must also run outside any open transaction.
      sleepOpenStates.push(hasOpenTransaction(mempoolDb));
    });

    const commitSpy = sinon.spy(mempoolDb, 'endTransaction');

    await tracker.updateMempool();

    // Several batches were fetched (2500 / 1000 -> 3 fetches).
    expect(tracker.connector.getRawTransactions.callCount).to.be.greaterThan(1);

    // The core invariant: NO fetch and NO sleep saw an open transaction.
    expect(fetchOpenStates.length).to.be.greaterThan(1);
    expect(fetchOpenStates.every((open) => open === false), 'no RPC fetch inside a transaction').to.equal(true);
    expect(sleepOpenStates.length).to.be.greaterThan(0);
    expect(sleepOpenStates.every((open) => open === false), 'no inter-batch sleep inside a transaction').to.equal(true);

    // Commits are incremental (prune + one per batch), not a single spanning
    // commit at the very end.
    const committingCalls = commitSpy.getCalls().filter((c) => c.args[0] !== false);
    expect(committingCalls.length).to.be.greaterThan(2);

    // The pass reconverged and the busy flag was released.
    expect(tracker.mempoolReconverged).to.equal(true);
    expect(tracker.mempoolBusy).to.equal(false);
  });

  it('leaves no open transaction and clears the busy flag when a batch fetch fails permanently', async function () {
    const txids = [];
    for (let i = 0; i < TXID_COUNT; i++) txids.push(randTxid());

    sinon.stub(tracker.connector, 'getRawMempool').resolves(txids.slice());
    // Always fail the tx fetch so the pass gives up after the retry budget.
    sinon.stub(tracker.connector, 'getRawTransactions').rejects(new Error('node down'));
    // Immediate sleeps so the retry loop does not actually wait.
    sinon.stub(tracker, 'sleep').resolves();

    await tracker.updateMempool();

    // A permanently failing fetch must not strand an open transaction or wedge
    // the busy flag (which would lock out every future interval tick).
    expect(hasOpenTransaction(mempoolDb)).to.equal(false);
    expect(tracker.mempoolBusy).to.equal(false);
    expect(tracker.mempoolRpcFailures).to.be.greaterThan(0);
  });
});

// : Phase 1's prune COMMITS before Phase 2 fetches the new txids, so a pass
// that gives up mid-fetch leaves a snapshot missing those spends. The abort was a
// plain `break` falling through to an unconditional mempoolReconverged = true, so the
// partial snapshot published as ready and getUtxosAddress served the confirmed inputs
// of spends the mempool index could not see.
describe('updateMempool readiness after an incomplete pass ()', function () {
  let tracker;
  let db;
  let mempoolDb;

  beforeEach(async function () {
    tracker = new XChainUtxoTracker(
      'bitcoin-regtest', '127.0.0.1', '18443', 'user', 'pass', 'test-db', false
    );
    db = new LevelUpStore('tracker-ready-' + Date.now(), true);
    mempoolDb = new LevelUpStore('mempool-ready-' + Date.now(), true);
    await db.createDatabase();
    await mempoolDb.createDatabase();
    tracker.db = db;
    tracker.mempoolDb = mempoolDb;
    tracker.blockchainInfoLastBlock = 1000;
    // Start from a previously-good pass: leaving that stale true asserted is the bug.
    tracker.mempoolReconverged = true;
  });

  afterEach(async function () {
    sinon.restore();
    try { await db.close(); } catch (e) {}
    try { await mempoolDb.close(); } catch (e) {}
  });

  it('withdraws readiness when the tx fetch is abandoned after the retry budget', async function () {
    const txids = [];
    for (let i = 0; i < TXID_COUNT; i++) txids.push(randTxid());

    sinon.stub(tracker.connector, 'getRawMempool').resolves(txids.slice());
    sinon.stub(tracker.connector, 'getRawTransactions').rejects(new Error('node down'));
    sinon.stub(tracker, 'sleep').resolves();

    await tracker.updateMempool();

    expect(tracker.mempoolReconverged, 'a partially fetched post-prune snapshot is not ready').to.equal(false);
    // Recovery is unchanged: the finally still releases the interval lock.
    expect(tracker.mempoolBusy).to.equal(false);
  });

  it('withdraws readiness when a batch fails to parse mid-pass', async function () {
    const txids = [];
    for (let i = 0; i < TXID_COUNT; i++) txids.push(randTxid());

    sinon.stub(tracker.connector, 'getRawMempool').resolves(txids.slice());
    // The fetch succeeds and the decode of the returned hex fails, which routes
    // through the batch catch to the outer catch rather than through the abort.
    sinon.stub(tracker.connector, 'getRawTransactions').callsFake(async (chunk) => chunk.map(() => 'deadbeef'));
    sinon.stub(tracker.xchainBlockDecoder, 'txFromHex').throws(new Error('malformed tx hex'));
    sinon.stub(tracker, 'sleep').resolves();

    await tracker.updateMempool();

    expect(tracker.mempoolReconverged, 'a mid-pass parse fault leaves the same partial snapshot').to.equal(false);
    expect(tracker.mempoolBusy).to.equal(false);
  });

  it('still asserts readiness when every advertised tx was fetched and committed', async function () {
    const txids = [];
    for (let i = 0; i < TXID_COUNT; i++) txids.push(randTxid());

    sinon.stub(tracker.connector, 'getRawMempool').resolves(txids.slice());
    sinon.stub(tracker.connector, 'getRawTransactions').callsFake(async (chunk) => chunk.map(() => null));
    sinon.stub(tracker, 'sleep').resolves();

    tracker.mempoolReconverged = false;
    await tracker.updateMempool();

    expect(tracker.mempoolReconverged, 'a complete pass must re-assert readiness').to.equal(true);
    expect(tracker.mempoolBusy).to.equal(false);
  });
});
