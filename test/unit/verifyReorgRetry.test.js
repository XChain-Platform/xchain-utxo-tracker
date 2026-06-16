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
const XChainUtxoTracker = require('../../src/XChainUtxoTracker');

// Regression test for the per-block retry budget in verifyReorg.
//
// Bug: retryCount was declared once before the block-deletion loop and shared
// across every block removed in a reorg. A multi-block reorg with a few transient
// delete failures per block could exhaust the 10-attempt budget collectively and
// abort before all orphan blocks were removed, leaving the UTXO index inconsistent.
//
// Fix: reset retryCount to 0 after each successful rollback, so the 10-attempt
// limit is per-block rather than per-reorg-run.
describe('XChainUtxoTracker.verifyReorg retry budget', function () {
  this.timeout(0);

  // Stub the tracker's db + connector to model an orphan chain whose top three
  // blocks (102, 101, 100) disagree with the node and must be rolled back; height
  // 99 matches the node and ends the walk. Each db.deleteBlock fails
  // `failuresPerBlock` times transiently before succeeding.
  function buildTracker(failuresPerBlock) {
    const tracker = new XChainUtxoTracker(
      'bitcoin-regtest', '127.0.0.1', '18443', 'user', 'pass', 'test-db', false
    );
    tracker.undoBlocks = 1000;       // keep the reorg-depth guard out of the way
    tracker.sleep = async () => {};
    tracker.removeFromLastBlocks = async () => {};

    let top = 102;
    const failsLeft = { 102: failuresPerBlock, 101: failuresPerBlock, 100: failuresPerBlock };
    const deleted = [];
    const heightOf = (hash) => parseInt(hash.replace('db', ''), 10);

    // node agrees with the db at/below height 99 ('db99'), disagrees above it.
    tracker.connector = {
      getBlockHash: async (h) => (h <= 99 ? 'db' + h : 'node' + h)
    };
    tracker.db = {
      getLastBlockHeight: async () => top,
      getLastBlockHash: async () => 'db' + top,
      getBlock: async (hash) => {
        const h = heightOf(hash);
        return { h, ph: 'db' + (h - 1) };
      },
      getLastBlock: async () => ({ hash: 'db' + top, height: top }),
      beginTransaction: async () => {},
      endTransaction: async () => {},
      removeOutputScriptsInBlock: async () => {},
      processDeletedOutputs: async () => {},
      removeCreatedOutputsInBlock: async () => {},
      deleteBlock: async (hash) => {
        const h = heightOf(hash);
        if (failsLeft[h] > 0) { failsLeft[h]--; throw new Error('transient DB error'); }
        deleted.push(h);
        top = h - 1;
      },
      setLastBlockHash: async () => {},
      setLastBlockHeight: async () => {}
    };

    return { tracker, deleted };
  }

  it('resets the budget per block so a multi-block reorg with per-block transient failures removes every orphan block', async function () {
    // 3 orphan blocks × 4 transient failures = 12 total (> the 10-attempt budget)
    // but only 4 per block (< 10). Pre-fix the shared counter hit 10 mid-reorg and
    // aborted; post-fix each block gets its own budget and all three roll back.
    const { tracker, deleted } = buildTracker(4);

    const result = await tracker.verifyReorg();

    expect(result).to.equal(true);
    expect(deleted).to.deep.equal([102, 101, 100]);
  });

  it('still aborts when a single block genuinely fails 10 times in a row', async function () {
    // The per-block reset must not turn the limit into infinite retry.
    const { tracker } = buildTracker(10);
    let threw = false;
    try {
      await tracker.verifyReorg();
    } catch (err) {
      threw = true;
      expect(err.message).to.match(/failed after 10 attempts/);
    }
    expect(threw, 'verifyReorg should abort after 10 consecutive failures').to.equal(true);
  });
});
