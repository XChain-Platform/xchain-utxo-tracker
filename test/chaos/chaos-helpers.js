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

const integrationHelpers = require('../integration/helpers');

// Re-export everything from integration helpers
module.exports = { ...integrationHelpers };

// ─── Timing ─────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function measureMs(asyncFn) {
  const start = process.hrtime.bigint();
  const result = await asyncFn();
  const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
  return { result, ms: elapsed };
}

// ─── LevelDB Fault Injectors ────────────────────────────────────────────────

/**
 * Monkey-patches db.db.batch to reject with the given error.
 * Target: LevelUpDb.js:290 — endTransaction() calls this.db.batch()
 * Returns { restore() } to undo the patch.
 */
function injectBatchWriteFailure(levelUpStore, error) {
  const original = levelUpStore.db.batch.bind(levelUpStore.db);
  levelUpStore.db.batch = () => Promise.reject(error);
  return {
    restore() { levelUpStore.db.batch = original; }
  };
}

/**
 * Wraps the underlying LevelDB get() and iterator() with delays.
 * get() is used for point lookups; iterator() for range scans
 * (getOutputsScriptPubKey, getBalanceInfo, etc.).
 * Returns { restore() }.
 */
function injectReadLatency(levelUpStore, delayMs) {
  const originalGet = levelUpStore.db.get.bind(levelUpStore.db);
  const originalIterator = levelUpStore.db.iterator.bind(levelUpStore.db);

  levelUpStore.db.get = async function (key, opts) {
    await sleep(delayMs);
    return originalGet(key, opts);
  };

  // abstract-level iterators are consumed via `for await (const [k,v] of it)`,
  // which drives it.next(). Delay the first next() to simulate scan latency.
  levelUpStore.db.iterator = function (opts) {
    const it = originalIterator(opts);
    const originalNext = it.next.bind(it);
    let delayed = false;
    it.next = async function (...args) {
      if (!delayed) { delayed = true; await sleep(delayMs); }
      return originalNext(...args);
    };
    return it;
  };

  return {
    restore() {
      levelUpStore.db.get = originalGet;
      levelUpStore.db.iterator = originalIterator;
    }
  };
}

/**
 * Directly overwrites LAST_BLOCK_HEIGHT and/or LAST_BLOCK_HASH via the
 * underlying LevelDB instance, bypassing transactionArray. The DB is opened
 * with buffer encodings, so keys/values are written as their byte Buffers
 * (matches LevelUpDb's metadata schema).
 */
async function corruptStateAnchor(levelUpStore, { height, hash } = {}) {
  if (height !== undefined) {
    await levelUpStore.db.put(Buffer.from('LAST_BLOCK_HEIGHT'), Buffer.from(height.toString(16)));
  }
  if (hash !== undefined) {
    await levelUpStore.db.put(Buffer.from('LAST_BLOCK_HASH'), Buffer.from(hash));
  }
}

/**
 * Deletes LAST_BLOCK_HEIGHT and/or LAST_BLOCK_HASH from the store.
 */
async function deleteStateAnchors(levelUpStore) {
  try { await levelUpStore.db.del(Buffer.from('LAST_BLOCK_HEIGHT')); } catch (e) {}
  try { await levelUpStore.db.del(Buffer.from('LAST_BLOCK_HASH')); } catch (e) {}
}

// ─── Reorg Helpers ──────────────────────────────────────────────────────────

/**
 * Forces verifyReorg() to run in direct-write mode (no transactionArray).
 * Mirrors the pattern from reorg.test.js:26-33.
 */
async function forceVerifyReorg(tracker) {
  if (tracker.db.transactionArray) {
    await tracker.db.endTransaction(false);
  }
  tracker.db.transactionArray = null;
  tracker.db.deletedTransactionArray = null;
  await tracker.verifyReorg();
}

// ─── Convenience ────────────────────────────────────────────────────────────

/**
 * Builds a chain of coinbase blocks and commits them to the tracker.
 * Returns the blocks array.
 */
async function buildCommittedChain(tracker, count, addressIndex = 0) {
  const blocks = integrationHelpers.buildCoinbaseChain(count, addressIndex);
  await integrationHelpers.processBlocksAndCommit(tracker, blocks);
  return blocks;
}

module.exports = Object.assign(module.exports, {
  sleep,
  measureMs,
  injectBatchWriteFailure,
  injectReadLatency,
  corruptStateAnchor,
  deleteStateAnchors,
  forceVerifyReorg,
  buildCommittedChain
});
