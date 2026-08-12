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
const LevelUpStore = require('../../src/LevelUpDb');
const XChainUtxoTracker = require('../../src/XChainUtxoTracker');

const P_PENDING_CLEANUP_KEY = Buffer.from([0x50]);

// Regression: mid-batch tip-regression discards the in-flight batch.
//
// The true tip-regression branch in start() (a node reset / reindex /
// invalidateblock that drops the node tip below our processed height) can be
// reached mid-batch by a periodic blockchain-info refresh, while a LevelDB
// batch is still open holding staged writes for blocks about to be rolled back.
// verifyReorg opens its OWN transaction, so leaving the stale batch in place
// either strands phantom UTXOs (committed at the next flush) or, once
// verifyReorg nulls transactionArray, routes later writes as unbatched direct
// puts while the batch counter is still > 0. discardInflightBatchForReorg
// rolls the batch back and persists the aged-block cleanup list out-of-band.
describe('discardInflightBatchForReorg', function () {
  let tracker, db;

  beforeEach(async function () {
    tracker = new XChainUtxoTracker('bitcoin-regtest', '127.0.0.1', '18443', 'u', 'p', 'discard-db', false);
    db = new LevelUpStore('discard-' + Date.now() + '-' + Math.random(), true);
    await db.createDatabase();
    tracker.db = db;
    tracker.pendingKMCleanup = [];
  });
  afterEach(async function () { try { await db.close(); } catch (e) {} });

  it('is a no-op when no batch is in flight (blocksQuantity <= 0)', async function () {
    const discarded = await tracker.discardInflightBatchForReorg(0);
    expect(discarded).to.equal(false);
    // Nothing staged, nothing to persist.
    expect(await db.db.get(P_PENDING_CLEANUP_KEY)).to.equal(undefined);
  });

  it('discards staged phantom writes so they can never be committed', async function () {
    // Simulate a mid-batch state: open a transaction and stage a phantom UTXO.
    await db.beginTransaction();
    const scriptHash = 'a'.repeat(64);
    const fullTxid = 'd'.repeat(64);
    await db.insertOutput({ scriptPubKey: scriptHash, txHash: fullTxid.substring(0, 16), outputIndex: 0, value: BigInt(5000), height: 10, fullTxHash: fullTxid, coinbase: false });

    const discarded = await tracker.discardInflightBatchForReorg(3);
    expect(discarded).to.equal(true);

    // The batch was rolled back (endTransaction(false)): a fresh beginTransaction
    // must be required, and the phantom output was never written to the store.
    expect(db.transactionArray).to.equal(null);
    const outputs = await db.getOutputsScriptPubKey(scriptHash);
    expect(outputs).to.have.length(0);
  });

  it('persists the aged-block cleanup list out-of-band and clears it in memory', async function () {
    await db.beginTransaction();
    tracker.pendingKMCleanup = ['blockhashA', 'blockhashB'];

    await tracker.discardInflightBatchForReorg(5);

    // The P key was persisted with a standalone put (outside the rolled-back
    // batch) so restart recovery still runs cleanupAgedBlocks for these blocks.
    const pVal = await db.db.get(P_PENDING_CLEANUP_KEY);
    expect(pVal).to.not.equal(undefined);
    expect(JSON.parse(pVal.toString())).to.deep.equal(['blockhashA', 'blockhashB']);
    // In-memory list is cleared (the caller then zeroes its batch counters).
    expect(tracker.pendingKMCleanup).to.deep.equal([]);
  });
});

// Regression: bounded block-fetch retry fails loud on desync.
//
// A node pruned past our cursor (or any permanent fetch fault) previously became
// an infinite 3s retry loop with no fail-loud signal. noteBlockFetchFailure
// counts consecutive failures at the SAME height, resets on a height change, and
// throws a diagnosable desync error once MAX_BLOCK_FETCH_RETRIES is hit so the
// polling loop's top-level guard exits for a supervised restart.
describe('noteBlockFetchFailure', function () {
  let tracker;
  const MAX = XChainUtxoTracker.MAX_BLOCK_FETCH_RETRIES;

  beforeEach(function () {
    tracker = new XChainUtxoTracker('bitcoin-regtest', '127.0.0.1', '18443', 'u', 'p', 'desync-db', false);
  });

  it('increments the streak while the same height keeps failing', function () {
    const err = new Error('pruned');
    let s = tracker.noteBlockFetchFailure(100, null, 0, err);
    expect(s).to.deep.equal({ height: 100, count: 1 });
    s = tracker.noteBlockFetchFailure(100, s.height, s.count, err);
    expect(s).to.deep.equal({ height: 100, count: 2 });
  });

  it('resets the streak to 1 when the height changes (we advanced past the block)', function () {
    const err = new Error('blip');
    const s = tracker.noteBlockFetchFailure(101, 100, 7, err);
    expect(s).to.deep.equal({ height: 101, count: 1 });
  });

  it('throws a diagnosable desync error and records state at the retry bound', function () {
    const err = new Error('Block not available (pruned data)');
    let s = { height: 200, count: MAX - 1 };
    // The next failure at the same height reaches the bound.
    let threw = null;
    try {
      tracker.noteBlockFetchFailure(200, s.height, s.count, err);
    } catch (e) { threw = e; }

    expect(threw, 'should throw at the retry bound').to.be.an('error');
    expect(threw.message).to.match(/desync/i);
    expect(threw.message).to.include('200');
    expect(tracker.blockFetchDesync).to.be.an('object');
    expect(tracker.blockFetchDesync.height).to.equal(200);
    expect(tracker.blockFetchDesync.failures).to.equal(MAX);
    expect(tracker.blockFetchDesync.lastError).to.include('pruned');
    expect(tracker.blockFetchDesync.detectedAt).to.be.a('number');
  });

  it('does not throw or set desync state while below the bound', function () {
    tracker.noteBlockFetchFailure(300, 300, 1, new Error('x'));
    expect(tracker.blockFetchDesync).to.equal(null);
  });
});
