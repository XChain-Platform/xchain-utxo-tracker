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

function createRetryState(failuresPerBlock) {
  let top = 102;
  const failsLeft = { 102: failuresPerBlock, 101: failuresPerBlock, 100: failuresPerBlock };
  const deleted = [];
  const heightOf = (hash) => parseInt(hash.replace('db', ''), 10);

  // node agrees with the db at/below height 99 ('db99'), disagrees above it.
  const connector = {
    getBlockHash: async (h) => (h <= 99 ? 'db' + h : 'node' + h)
  };
  const db = {
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

  return { connector, db, deleted };
}

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
    // A full persisted window (the stub above never shrinks it): the rollback
    // budget is derived from the window at entry, and an empty one is refused.
    tracker.lastBlocks = Array.from({ length: tracker.undoBlocks }, (_, i) => "w" + i);

    const { connector, db, deleted } = createRetryState(failuresPerBlock);
    tracker.connector = connector;
    tracker.db = db;

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

describe('XChainUtxoTracker.verifyReorg retry budget', function () {
  this.timeout(0);

  it('throws a clear error (not a TypeError) when the block index is empty but a pointer is set', async function () {
    // Corrupt state: LAST_BLOCK_HASH points at a block whose record is gone, and
    // getLastBlock() returns null (B-prefix empty). The repair branch must not
    // dereference null.height/.hash; it must abort with an actionable message.
    const tracker = new XChainUtxoTracker(
      'bitcoin-regtest', '127.0.0.1', '18443', 'user', 'pass', 'test-db', false
    );
    tracker.sleep = async () => {};
    tracker.db = {
      getLastBlockHeight: async () => 100,
      getLastBlockHash: async () => 'db100',
      getBlock: async () => null,          // pointer's block record is gone
      getLastBlock: async () => null       // B-prefix is empty
    };

    let err = null;
    try {
      await tracker.verifyReorg();
    } catch (e) {
      err = e;
    }
    expect(err, 'verifyReorg should throw on a corrupt empty index').to.be.an('error');
    expect(err).to.not.be.an.instanceof(TypeError);
    expect(err.message).to.match(/corrupt|resync/i);
  });
});

// Regression test for the node-tip-below-committed path (a node reset / reindex /
// invalidateblock that drops the chain below our committed tip). verifyReorg(nodeTip)
// must delete the blocks above the node tip WITHOUT calling getBlockHash for those
// heights (the node cannot answer them), then reconcile by hash at the node tip.
describe('XChainUtxoTracker.verifyReorg node-tip-below-committed', function () {
  this.timeout(0);

  it('rolls back blocks above the node tip without querying their hash', async function () {
    const tracker = new XChainUtxoTracker(
      'bitcoin-regtest', '127.0.0.1', '18443', 'user', 'pass', 'test-db', false
    );
    tracker.undoBlocks = 1000;
    tracker.sleep = async () => {};
    tracker.removeFromLastBlocks = async () => {};
    // Same full persisted window as buildTracker, for the same reason.
    tracker.lastBlocks = Array.from({ length: tracker.undoBlocks }, (_, i) => "w" + i);

    let top = 105;                 // committed tip
    const nodeTip = 102;           // node regressed below us
    const deleted = [];
    const queriedHeights = [];
    const heightOf = (hash) => parseInt(hash.replace('db', ''), 10);

    tracker.connector = {
      // The node only has heights <= nodeTip; asking for anything above is an error.
      getBlockHash: async (h) => {
        queriedHeights.push(h);
        if (h > nodeTip) throw new Error('Block height out of range');
        return 'db' + h;           // node agrees with us at/below the node tip
      }
    };
    tracker.db = {
      getLastBlockHeight: async () => top,
      getLastBlockHash: async () => 'db' + top,
      getBlock: async (hash) => { const h = heightOf(hash); return { h, ph: 'db' + (h - 1) }; },
      getLastBlock: async () => ({ hash: 'db' + top, height: top }),
      beginTransaction: async () => {},
      endTransaction: async () => {},
      removeOutputScriptsInBlock: async () => {},
      processDeletedOutputs: async () => {},
      removeCreatedOutputsInBlock: async () => {},
      deleteBlock: async (hash) => { const h = heightOf(hash); deleted.push(h); top = h - 1; },
      setLastBlockHash: async () => {},
      setLastBlockHeight: async () => {}
    };

    const result = await tracker.verifyReorg(nodeTip);

    expect(result).to.equal(true);
    // 105/104/103 are above the node tip and rolled back; 102 matches and ends the walk.
    expect(deleted).to.deep.equal([105, 104, 103]);
    // getBlockHash must never be called for a height the node lacks (would have thrown).
    expect(queriedHeights.every((h) => h <= nodeTip)).to.equal(true);
  });
});

// Committed tip `top`; the node has heights <= nodeTip and agrees with us there.
function buildTipDropTracker({ top = 105, nodeTip = 100, info, undoBlocks = 1000 } = {}) {
  const tracker = new XChainUtxoTracker(
    'bitcoin-regtest', '127.0.0.1', '18443', 'user', 'pass', 'test-db', false
  );
  tracker.undoBlocks = undoBlocks;
  tracker.removeFromLastBlocks = async () => {};
  tracker.lastBlocks = Array.from({ length: tracker.undoBlocks }, (_, i) => 'w' + i);
  // A regression would retry forever: fail fast instead of hanging mocha.
  let sleeps = 0;
  tracker.sleep = async () => { if (++sleeps > 50) throw new Error('walk spun: sleep budget exhausted'); };
  const state = { top, nodeTip, deleted: [], queried: [], infoCalls: 0 };
  const heightOf = (hash) => parseInt(hash.replace('db', ''), 10);
  tracker.connector = {
    getBlockHash: async (h) => {
      state.queried.push(h);
      if (h > state.nodeTip) throw new Error('Block height out of range');
      return 'db' + h;
    },
    getBlockchainInfo: async () => {
      state.infoCalls++;
      if (typeof info === 'function') return info(state);
      return info || { blocks: state.nodeTip, initialblockdownload: false, verificationprogress: 1 };
    }
  };
  tracker.db = {
    getLastBlockHeight: async () => state.top,
    getLastBlockHash: async () => 'db' + state.top,
    getBlock: async (hash) => { const h = heightOf(hash); return { h, ph: 'db' + (h - 1) }; },
    getLastBlock: async () => ({ hash: 'db' + state.top, height: state.top }),
    beginTransaction: async () => {},
    endTransaction: async () => {},
    removeOutputScriptsInBlock: async () => {},
    processDeletedOutputs: async () => {},
    removeCreatedOutputsInBlock: async () => {},
    deleteBlock: async (hash) => { const h = heightOf(hash); state.deleted.push(h); state.top = h - 1; },
    setLastBlockHash: async () => {},
    setLastBlockHeight: async () => {}
  };
  return { tracker, state };
}

// The node's tip can drop below the walk AFTER verifyReorg starts (node restart onto
// a shorter chain, a second reorg), and two callers pass no tip at all. A failed hash
// fetch must re-read the tip, or the walk asks for a height the node lacks forever.
describe('XChainUtxoTracker.verifyReorg mid-walk tip refresh', function () {
  this.timeout(0);

  it('re-reads the tip when a no-tip walk cannot fetch a hash, then rolls back the orphaned heights', async function () {
    const { tracker, state } = buildTipDropTracker();
    expect(await tracker.verifyReorg()).to.equal(true);
    expect(state.deleted).to.deep.equal([105, 104, 103, 102, 101]);
    // Only the first failed fetch asks above the node tip; the rest are rolled back unasked.
    expect(state.queried.filter((h) => h > 100)).to.deep.equal([105]);
  });

  it('lowers a tip the caller passed when it drops further mid-walk', async function () {
    const { tracker, state } = buildTipDropTracker({ top: 105, nodeTip: 100 });
    expect(await tracker.verifyReorg(103)).to.equal(true);
    expect(state.deleted).to.deep.equal([105, 104, 103, 102, 101]);
  });

  it('refuses, tagged and before any delete, when the refreshed gap exceeds the undo window', async function () {
    const { tracker, state } = buildTipDropTracker({ top: 105, nodeTip: 100, undoBlocks: 3 });
    let err = null;
    try { await tracker.verifyReorg(); } catch (e) { err = e; }
    expect(err, 'expected the above-tip budget refusal').to.be.an('error');
    expect(err.tipBelowCommittedTip).to.equal(true);
    expect(state.deleted).to.deep.equal([]);
  });

  it('does not lower the tip on a node still in initial block download', async function () {
    // The node reports IBD at 100 for a few reads, then catches up past our tip.
    const { tracker, state } = buildTipDropTracker({
      info: (s) => {
        if (s.infoCalls >= 3) s.nodeTip = 110;
        return { blocks: s.infoCalls >= 3 ? 110 : 100, initialblockdownload: s.infoCalls < 3, verificationprogress: 1 };
      }
    });
    expect(await tracker.verifyReorg()).to.equal(true);
    expect(state.deleted).to.deep.equal([]);
  });

  it('keeps sleeping and retrying when the tip cannot be read, as before', async function () {
    let fetches = 0;
    const { tracker, state } = buildTipDropTracker({ top: 105, nodeTip: 105 });
    tracker.connector.getBlockHash = async (h) => { if (++fetches <= 3) throw new Error('ECONNREFUSED'); return 'db' + h; };
    tracker.connector.getBlockchainInfo = async () => { throw new Error('ECONNREFUSED'); };
    expect(await tracker.verifyReorg()).to.equal(true);
    expect(state.deleted).to.deep.equal([]);
    delete tracker.connector.getBlockchainInfo;
    fetches = 0;
    expect(await tracker.verifyReorg()).to.equal(true);
  });
});

// The two callers that pass no tip must not let the walk's tagged refusal escape
// start(): they hand it back to the sync loop's tip check and reset the batch.
describe('no-tip reorg callers hand a tip refusal back to the tip check', function () {
  const { verifyReorgHandingBackTipRefusal } = require('../../src/XChainUtxoTracker/sync_loop_block_apply.js');

  it('swallows a tagged tipBelowCommittedTip and drops the cached tip', async function () {
    const sync = { lastBlockchainInfo: { blocks: 100 } };
    const tracker = { verifyReorg: async () => { const e = new Error('below'); e.tipBelowCommittedTip = true; throw e; } };
    await verifyReorgHandingBackTipRefusal.call(tracker, sync);
    expect(sync.lastBlockchainInfo).to.equal(null);
  });

  it('rethrows any other error unchanged', async function () {
    const sync = { lastBlockchainInfo: { blocks: 100 } };
    const boom = new Error('unrecoverable');
    const tracker = { verifyReorg: async () => { throw boom; } };
    let caught = null;
    try { await verifyReorgHandingBackTipRefusal.call(tracker, sync); } catch (e) { caught = e; }
    expect(caught).to.equal(boom);
    expect(sync.lastBlockchainInfo).to.deep.equal({ blocks: 100 });
  });

  it('is what both no-tip call sites use', function () {
    const fs = require('fs');
    const path = require('path');
    for (const f of ['sync_loop_block_apply.js', 'sync_loop_node_tip.js']) {
      const src = fs.readFileSync(path.join(__dirname, '../../src/XChainUtxoTracker', f), 'utf8');
      expect(src, f).to.match(/await verifyReorgHandingBackTipRefusal\.call\(this, sync\)/);
      // Only the helper itself may run the bare no-tip walk.
      const bare = (src.match(/await this\.verifyReorg\(\)/g) || []).length;
      expect(bare, f).to.equal(f === 'sync_loop_block_apply.js' ? 1 : 0);
    }
  });
});
