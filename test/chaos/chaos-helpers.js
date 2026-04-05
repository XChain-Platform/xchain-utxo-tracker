'use strict';

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
 * Wraps db.db.get and db.db.createReadStream with delays.
 * get() is used for point lookups; createReadStream() for range scans
 * (getOutputsScriptPubKey, getBalanceInfo, etc.).
 * Returns { restore() }.
 */
function injectReadLatency(levelUpStore, delayMs) {
  const originalGet = levelUpStore.db.get.bind(levelUpStore.db);
  const originalStream = levelUpStore.db.createReadStream.bind(levelUpStore.db);

  levelUpStore.db.get = async function (key, opts) {
    await sleep(delayMs);
    return originalGet(key, opts);
  };

  levelUpStore.db.createReadStream = function (opts) {
    const { PassThrough } = require('stream');
    const pt = new PassThrough({ objectMode: true });
    setTimeout(() => {
      const real = originalStream(opts);
      real.pipe(pt);
      real.on('error', (err) => pt.destroy(err));
    }, delayMs);
    return pt;
  };

  return {
    restore() {
      levelUpStore.db.get = originalGet;
      levelUpStore.db.createReadStream = originalStream;
    }
  };
}

/**
 * Directly overwrites LAST_BLOCK_HEIGHT and/or LAST_BLOCK_HASH via the
 * underlying levelup instance, bypassing transactionArray.
 */
async function corruptStateAnchor(levelUpStore, { height, hash } = {}) {
  if (height !== undefined) {
    await levelUpStore.db.put('LAST_BLOCK_HEIGHT', height.toString(16));
  }
  if (hash !== undefined) {
    await levelUpStore.db.put('LAST_BLOCK_HASH', hash);
  }
}

/**
 * Deletes LAST_BLOCK_HEIGHT and/or LAST_BLOCK_HASH from the store.
 */
async function deleteStateAnchors(levelUpStore) {
  try { await levelUpStore.db.del('LAST_BLOCK_HEIGHT'); } catch (e) {}
  try { await levelUpStore.db.del('LAST_BLOCK_HASH'); } catch (e) {}
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
