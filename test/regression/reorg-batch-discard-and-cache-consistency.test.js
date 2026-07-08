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
const crypto = require('crypto');
const LevelUpStore = require('../../src/LevelUpDb');
const XChainUtxoTracker = require('../../src/XChainUtxoTracker');

function randHash() { return crypto.randomBytes(32).toString('hex'); }
function randHash8() { return crypto.randomBytes(8).toString('hex'); }
function makeDb() { return new LevelUpStore('sweep-' + Date.now() + '-' + Math.random(), true); }

// ─── C7/C15: mempool (height<0) insertOutput must not poison the shared cache ──
//
// The process-global outputCache is shared by the confirmed and mempool stores.
// The mempool store is the only caller passing height=-1. A concurrent mempool
// parse of a just-mined tx would otherwise overwrite the confirmed height in the
// cache, and the confirming block's Pass 2 would archive a K restore record with
// height=-1 that a reorg then restores to the confirmed store (confirmations tip+2).
describe('Regression (stress-sweep C7): mempool insertOutput does not write the shared outputCache', function () {
  let db;
  beforeEach(async function () { LevelUpStore.outputCache = new Map(); db = makeDb(); await db.createDatabase(); });
  afterEach(async function () { try { await db.close(); } catch (e) {} LevelUpStore.outputCache = new Map(); });

  function cacheKeyFor(txHash8, idx) {
    return txHash8 + String.fromCharCode((idx >>> 16) & 0xFFFF, idx & 0xFFFF);
  }

  it('a confirmed output (height>=0) is cached', async function () {
    const tx8 = randHash8();
    await db.beginTransaction();
    await db.insertOutput({ scriptPubKey: randHash(), txHash: tx8, outputIndex: 0, value: BigInt(1000), height: 42, fullTxHash: randHash(), coinbase: false });
    expect(LevelUpStore.outputCache.has(cacheKeyFor(tx8, 0))).to.equal(true);
  });

  it('a mempool output (height<0) is NOT cached', async function () {
    const tx8 = randHash8();
    await db.beginTransaction();
    await db.insertOutput({ scriptPubKey: randHash(), txHash: tx8, outputIndex: 0, value: BigInt(1000), height: -1, fullTxHash: randHash(), coinbase: false });
    expect(LevelUpStore.outputCache.has(cacheKeyFor(tx8, 0))).to.equal(false);
  });

  it('a mempool insert cannot overwrite a confirmed cache entry', async function () {
    const tx8 = randHash8();
    await db.beginTransaction();
    // Confirmed Pass 1 caches height 42.
    await db.insertOutput({ scriptPubKey: randHash(), txHash: tx8, outputIndex: 0, value: BigInt(1000), height: 42, fullTxHash: randHash(), coinbase: false });
    // Concurrent mempool re-parse (height -1) must not clobber the cached value.
    await db.insertOutput({ scriptPubKey: randHash(), txHash: tx8, outputIndex: 0, value: BigInt(1000), height: -1, fullTxHash: randHash(), coinbase: false });
    const cached = LevelUpStore.outputCache.get(cacheKeyFor(tx8, 0));
    expect(cached, 'entry survives').to.not.equal(undefined);
    // Decode the cached O-value and confirm the height is still 42, not -1.
    expect(LevelUpStore.decodeOutput(cached).h).to.equal(42);
  });
});

// ─── C5/C11: discarding a batch resets the knownScripts existence cache ───────
//
// insertOutputScriptBlock adds a script to the static knownScripts cache as soon
// as it STAGES the S/Z puts. If the batch is later discarded (mid-batch reorg),
// a stale cache entry makes the replacement chain's re-mined output Tier-0 hit and
// skip re-writing S/Z, permanently losing that script's first-seen height.
describe('Regression (stress-sweep C5): endTransaction(false) resets knownScripts', function () {
  let db;
  beforeEach(async function () { LevelUpStore.knownScripts = new Set(); db = makeDb(); await db.createDatabase(); });
  afterEach(async function () { try { await db.close(); } catch (e) {} LevelUpStore.knownScripts = new Set(); });

  it('a staged-then-discarded S/Z write does not leave a stale knownScripts entry', async function () {
    const script = randHash();
    const blockHash = randHash();
    await db.beginTransaction();
    await db.insertOutputScriptBlock(script, blockHash, 100);
    expect(LevelUpStore.knownScripts.has(script), 'staged script is remembered').to.equal(true);
    // Discard the batch (reorg rollback).
    await db.endTransaction(false);
    expect(LevelUpStore.knownScripts.size, 'cache reset on discard').to.equal(0);
  });

  it('a committed S/Z write leaves knownScripts populated (no spurious reset)', async function () {
    const script = randHash();
    await db.beginTransaction();
    await db.insertOutputScriptBlock(script, randHash(), 100);
    await db.endTransaction(true);
    expect(LevelUpStore.knownScripts.has(script)).to.equal(true);
  });
});

// ─── C9: removeTransactionIfExists must not cancel a staged DEL ────────────────
//
// It was written to cancel a create+remove-in-one-batch PUT, but blindly cancelled
// a staged DEL too. The P-key crash-recovery can replay a cleanup list that
// addToLastBlocks then re-shifts, so the same block is cleaned twice in one
// transaction; the second del cancelled the first, leaving the N record on disk.
describe('Regression (stress-sweep C9): removeTransactionIfExists only cancels a staged PUT', function () {
  let db;
  beforeEach(async function () { db = makeDb(); await db.createDatabase(); });
  afterEach(async function () { try { await db.close(); } catch (e) {} });

  it('cancels a staged PUT for the same key', async function () {
    const key = Buffer.from([0x4E, 1, 2, 3]);
    await db.beginTransaction();
    await db.addTransaction('put', key, Buffer.alloc(0));
    expect(db.removeTransactionIfExists(key)).to.equal(true);
    expect(db.transactionArray.has(key.toString('latin1'))).to.equal(false);
  });

  it('does NOT cancel a staged DEL (so a re-run still deletes)', async function () {
    const key = Buffer.from([0x4E, 4, 5, 6]);
    await db.beginTransaction();
    await db.addTransaction('del', key);
    expect(db.removeTransactionIfExists(key)).to.equal(false);
    // The del is still staged and will commit.
    const item = db.transactionArray.get(key.toString('latin1'));
    expect(item && item.type).to.equal('del');
  });

  it('a block cleaned twice in one batch still deletes its N record', async function () {
    const blockHash = randHash();
    // Put the N record on disk.
    await db.beginTransaction();
    await db.addLastStoredBlock(blockHash);
    await db.endTransaction(true);
    expect(await db.getLastStoredBlocks()).to.include(blockHash);

    // Now stage two removals of the same block in one batch (the double-clean case).
    await db.beginTransaction();
    await db.removeLastStoredBlock(blockHash);
    await db.removeLastStoredBlock(blockHash);
    await db.endTransaction(true);

    expect(await db.getLastStoredBlocks()).to.not.include(blockHash);
  });
});

// ─── C14: cleanupAgedBlocks never purges a block still in the live reorg window ─
//
// After a mid-batch reorg discards staged blocks, pendingKMCleanup can contain
// hashes that are once again the live committed tip (they were aged out against a
// stale in-memory window). Purging them would delete K/M/W/N records inside the
// undo window and wedge the next reorg. cleanupAgedBlocks skips any hash still in
// this.lastBlocks and dedupes the list.
describe('Regression (stress-sweep C14): cleanupAgedBlocks skips live-window + dedupes', function () {
  let tracker, db;
  beforeEach(async function () {
    tracker = new XChainUtxoTracker('bitcoin-regtest', '127.0.0.1', '18443', 'u', 'p', 'c14-db', false);
    db = makeDb(); await db.createDatabase();
    tracker.db = db;
  });
  afterEach(async function () { try { await db.close(); } catch (e) {} });

  it('does not delete N records for hashes still in the live window', async function () {
    const liveHash = randHash();
    const agedHash = randHash();
    // Both have N records on disk.
    await db.beginTransaction();
    await db.addLastStoredBlock(liveHash);
    await db.addLastStoredBlock(agedHash);
    await db.endTransaction(true);

    // liveHash is still in the reorg window; agedHash has genuinely aged out.
    tracker.lastBlocks = [liveHash];
    tracker.pendingKMCleanup = [liveHash, agedHash];

    await tracker.cleanupAgedBlocks();

    const stored = await db.getLastStoredBlocks();
    expect(stored, 'live-window N record survives').to.include(liveHash);
    expect(stored, 'aged N record purged').to.not.include(agedHash);
    expect(tracker.pendingKMCleanup).to.deep.equal([]);
  });

  it('a fully-poisoned list (all in-window) purges nothing', async function () {
    const a = randHash(), b = randHash();
    await db.beginTransaction();
    await db.addLastStoredBlock(a);
    await db.addLastStoredBlock(b);
    await db.endTransaction(true);

    tracker.lastBlocks = [a, b];
    tracker.pendingKMCleanup = [a, b, a]; // duplicate + all in-window

    await tracker.cleanupAgedBlocks();

    const stored = await db.getLastStoredBlocks();
    expect(stored).to.include(a);
    expect(stored).to.include(b);
  });
});

// ─── C4: paged getUtxosAddress dedupes a both-stores outpoint by point-probe ───
//
// hasOutputForTx is the page-independent confirmed-store membership probe used to
// avoid emitting a just-mined outpoint from BOTH the mempool store (page 1) and
// the confirmed store (a later page).
describe('Regression (stress-sweep C4): hasOutputForTx point-probe', function () {
  let db;
  beforeEach(async function () { db = makeDb(); await db.createDatabase(); });
  afterEach(async function () { try { await db.close(); } catch (e) {} });

  it('returns true for a live confirmed output and false otherwise', async function () {
    const script = randHash();
    const tx8 = randHash8();
    await db.beginTransaction();
    await db.insertOutput({ scriptPubKey: script, txHash: tx8, outputIndex: 0, value: BigInt(1), height: 5, fullTxHash: randHash(), coinbase: false });
    await db.insertOutputHint({ scriptPubKey: script, txHash: tx8, outputIndex: 0 });
    await db.endTransaction(true);

    expect(await db.hasOutputForTx(tx8, 0)).to.equal(true);
    expect(await db.hasOutputForTx(tx8, 7)).to.equal(false);
    expect(await db.hasOutputForTx(randHash8(), 0)).to.equal(false);
  });
});
