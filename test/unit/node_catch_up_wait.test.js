'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const XChainUtxoTracker = require('../../src/XChainUtxoTracker');
const { nodeStillCatchingUp } = XChainUtxoTracker;

// A node tip below the committed tip is not always a rollback. The decoder hit
// this on an operator's fresh BTC mainnet node (2026-09-07): the node was still
// in initial block download below the stored tip, the tip-regression branch
// called it a rollback, and the walk spent the whole window on a reorg that
// never happened. The tracker carries the same branch, so it carries the same
// two guards: the sync loop WAITS while initialblockdownload is true, and the
// above-tip walk, which knows its depth before the first delete, refuses up
// front when that depth cannot fit the window, with nothing deleted and no
// unrecoverable tag (the index is intact).
describe('XChainUtxoTracker: a node still catching up is not a rollback', function () {
  this.timeout(0);

  function newTracker() {
    const tracker = new XChainUtxoTracker(
      'bitcoin-regtest', '127.0.0.1', '18443', 'user', 'pass', 'test-db', false
    );
    tracker.sleep = async () => {};
    tracker.removeFromLastBlocks = async () => {};
    return tracker;
  }

  // Committed tip at `top`; the node agrees with every hash at or below its tip.
  function wire(tracker, top) {
    const deleted = [];
    const heightOf = (hash) => parseInt(hash.replace('db', ''), 10);
    tracker.connector = { getBlockHash: async (h) => 'db' + h };
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
    return deleted;
  }

  describe('nodeStillCatchingUp()', function () {
    it('is true only for a literal initialblockdownload=true', function () {
      expect(nodeStillCatchingUp({ initialblockdownload: true })).to.equal(true);
      expect(nodeStillCatchingUp({ initialblockdownload: false })).to.equal(false);
    });

    it('fails open on an absent or non-boolean field', function () {
      expect(nodeStillCatchingUp({ blocks: 5 })).to.equal(false);
      expect(nodeStillCatchingUp({ initialblockdownload: 'true' })).to.equal(false);
      expect(nodeStillCatchingUp(null)).to.equal(false);
      expect(nodeStillCatchingUp(undefined)).to.equal(false);
    });
  });

  describe('verifyReorg above-tip pre-delete refusal', function () {
    it('refuses with nothing deleted when the known depth exceeds the window', async function () {
      const tracker = newTracker();
      tracker.undoBlocks = 2;
      const deleted = wire(tracker, 105);

      let err = null;
      try { await tracker.verifyReorg(102); } catch (e) { err = e; }

      expect(err, 'a 3-deep gap cannot fit a 2-block window').to.be.an('error');
      expect(err.tipBelowCommittedTip).to.equal(true);
      expect(err.message).to.match(/3 blocks below the committed tip/);
      expect(err.message).to.match(/index is intact and no rebuild is needed/);
      expect(XChainUtxoTracker.isUnrecoverableReorg(err),
        'nothing was walked back, so this is not the rebuild class').to.equal(false);
      expect(deleted).to.deep.equal([]);
    });

    it('a gap of exactly the window still rolls back (the window is a budget, not a fence)', async function () {
      const tracker = newTracker();
      tracker.undoBlocks = 3;
      const deleted = wire(tracker, 105);

      expect(await tracker.verifyReorg(102)).to.equal(true);
      expect(deleted).to.deep.equal([105, 104, 103]);
    });
  });

  describe('the sync loop waits on initial block download', function () {
    const src = fs.readFileSync(path.join(__dirname, '../../src/XChainUtxoTracker.js'), 'utf8');
    // Source-level drift guard, the shape of reorg-detection-warn-level.test.js:
    // the branch needs a live node below our tip to reach.
    const detection = src.indexOf('The last processed block height are greater than the last block of the node');
    const branchTop = src.lastIndexOf('if (lastProcessedBlockIndex > this.blockchainInfoLastBlock)', detection);

    it('checks initialblockdownload before the regression is acted on', function () {
      expect(branchTop).to.be.greaterThan(0);
      const between = src.slice(branchTop, detection);
      expect(between).to.match(/nodeStillCatchingUp\(lastBlockchainInfo\)/);
      const at = between.indexOf('nodeStillCatchingUp(lastBlockchainInfo)');
      // Window sized to hold the whole wait branch (it also publishes the wait
      // state) while still ending well short of the verifyReorg call below it,
      // which is what the last assertion here is proving stays out of this path.
      const branch = between.slice(at, at + 1200);
      expect(branch).to.match(/await this\.sleep\(\d+\)/);
      expect(branch).to.match(/continue/);
      expect(branch).to.not.match(/verifyReorg/);
    });

    it('announces the wait at warn level, like every other tip-divergence line', function () {
      const at = src.indexOf('but the node reports initialblockdownload=true');
      expect(at).to.be.greaterThan(0);
      const m = src.slice(0, at).match(/console\.(log|warn|error)\("WARNING! The last processed block height \("[^;]*$/);
      expect(m && m[1]).to.equal('warn');
    });

    it('waits on the pre-delete refusal instead of exiting or halting for a rebuild', function () {
      const call = src.indexOf('await this.verifyReorg(this.blockchainInfoLastBlock)');
      expect(call).to.be.greaterThan(0);
      const after = src.slice(call, call + 1200);
      expect(after).to.match(/err\.tipBelowCommittedTip/);
      expect(after).to.match(/await this\.sleep\(\d+\)/);
      expect(after).to.match(/continue/);
      expect(after, 'the handler must not halt in place; the index needs no rebuild').to.not.match(/haltForResync\(/);
    });
  });
});
