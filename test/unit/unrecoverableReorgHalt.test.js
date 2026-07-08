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

// Durable fix for the unrecoverable-reorg crash-loop.
//
// Bug: when a reorg is deeper than the UNDO_BLOCKS recovery window (or the
// in-memory last-blocks window is empty), verifyReorg throws, start() rejects,
// and api.js's top-level guard process.exit(1)s. Docker's unless-stopped policy
// restarts into the identical stale on-disk tip every ~15s forever (observed
// 5000+ restarts on a BTC-testnet tracker).
//
// Fix: tag this fault class (unrecoverableReorg) so the top-level guard can HALT
// in place (haltForResync) instead of exiting, while transient faults still exit
// for a supervised restart. These tests pin the tagging + halt behavior.
describe('XChainUtxoTracker unrecoverable-reorg tagging + halt', function () {
  this.timeout(0);

  function newTracker() {
    return new XChainUtxoTracker(
      'bitcoin-regtest', '127.0.0.1', '18443', 'user', 'pass', 'test-db', false
    );
  }

  describe('markUnrecoverableReorg / isUnrecoverableReorg', function () {
    it('tags and detects only the flagged error class', function () {
      const plain = new Error('transient DB error');
      expect(XChainUtxoTracker.isUnrecoverableReorg(plain)).to.equal(false);

      const tagged = XChainUtxoTracker.markUnrecoverableReorg(new Error('deep reorg'));
      expect(XChainUtxoTracker.isUnrecoverableReorg(tagged)).to.equal(true);
      expect(tagged.unrecoverableReorg).to.equal(true);

      // Null/undefined must not throw and must read as recoverable.
      expect(XChainUtxoTracker.isUnrecoverableReorg(null)).to.equal(false);
      expect(XChainUtxoTracker.isUnrecoverableReorg(undefined)).to.equal(false);
    });
  });

  describe('removeFromLastBlocks empty window', function () {
    it('throws an error tagged unrecoverableReorg when the tracked window is empty', async function () {
      const tracker = newTracker();
      tracker.lastBlocks = [];
      let err = null;
      try {
        await tracker.removeFromLastBlocks('somehash');
      } catch (e) {
        err = e;
      }
      expect(err, 'should throw on an empty last-blocks window').to.be.an('error');
      expect(err.message).to.match(/list is empty \(reorg exceeds tracked window\)/);
      expect(XChainUtxoTracker.isUnrecoverableReorg(err)).to.equal(true);
    });
  });

  describe('verifyReorg depth guard', function () {
    // Orphan chain 105..102 disagrees with the node; 101 matches. undoBlocks=2, so
    // after rolling back two blocks the depth guard fires (the K/M recovery records
    // beyond the window are gone). That abort must be tagged unrecoverable.
    it('aborts with a tagged error once the reorg exceeds UNDO_BLOCKS', async function () {
      const tracker = newTracker();
      tracker.undoBlocks = 2;
      tracker.sleep = async () => {};
      tracker.removeFromLastBlocks = async () => {}; // isolate the depth guard

      let top = 105;
      const nodeTip = 101;
      const deleted = [];
      const heightOf = (hash) => parseInt(hash.replace('db', ''), 10);

      tracker.connector = {
        getBlockHash: async (h) => (h <= nodeTip ? 'db' + h : 'node' + h)
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

      let err = null;
      try {
        await tracker.verifyReorg();
      } catch (e) {
        err = e;
      }
      expect(err, 'verifyReorg should abort past the recovery window').to.be.an('error');
      expect(err.message).to.match(/reorg depth exceeds the recovery window/);
      expect(XChainUtxoTracker.isUnrecoverableReorg(err)).to.equal(true);
      // Rolled back exactly UNDO_BLOCKS blocks (105, 104) before the guard fired.
      expect(deleted).to.deep.equal([105, 104]);
    });
  });

  describe('verifyReorg empty-window during rollback', function () {
    // The reported crash: a block disagrees and must be rolled back, but the
    // in-memory last-blocks window is empty, so removeFromLastBlocks throws the
    // tagged error. The retry-catch must fail out IMMEDIATELY (tagged), not burn
    // 10 pointless retries against a window that stays empty.
    it('propagates the tagged error immediately without 10 retries', async function () {
      const tracker = newTracker();
      tracker.sleep = async () => {};
      tracker.loadLastBlocksSortedByHeight = async () => []; // window stays empty
      tracker.lastBlocks = []; // real removeFromLastBlocks throws tagged on first call

      let top = 141600;
      let deleteCalls = 0;
      const heightOf = (hash) => parseInt(hash.replace('db', ''), 10);

      tracker.connector = {
        getBlockHash: async () => 'node' + top // node always disagrees -> rollback needed
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
        deleteBlock: async () => { deleteCalls++; },
        setLastBlockHash: async () => {},
        setLastBlockHeight: async () => {}
      };

      let err = null;
      try {
        await tracker.verifyReorg();
      } catch (e) {
        err = e;
      }
      expect(err, 'verifyReorg should throw on an empty recovery window').to.be.an('error');
      expect(XChainUtxoTracker.isUnrecoverableReorg(err)).to.equal(true);
      // The fix fails out on the first empty-window throw rather than retrying 10x.
      expect(deleteCalls).to.equal(1);
    });
  });

  describe('haltForResync', function () {
    it('sets the halted state, records the reason, and clears the mempool interval', function () {
      const tracker = newTracker();
      let cleared = false;
      // A real interval so clearInterval is exercised; assert it is nulled.
      tracker.mempoolInterval = setInterval(() => {}, 1000000);
      const original = tracker.mempoolInterval;

      tracker.haltForResync('deep reorg on BTC testnet');

      expect(tracker.halted).to.equal(true);
      expect(tracker.haltReason).to.equal('deep reorg on BTC testnet');
      expect(tracker.mempoolInterval).to.equal(null);

      // Defensive: if the fix regressed and left the interval running, clear it so
      // the test process can exit.
      if (original && tracker.mempoolInterval) { clearInterval(original); }
      cleared = true;
      expect(cleared).to.equal(true);
    });

    it('falls back to a default reason when none is given', function () {
      const tracker = newTracker();
      tracker.haltForResync();
      expect(tracker.halted).to.equal(true);
      expect(tracker.haltReason).to.match(/unrecoverable reorg/i);
    });
  });
});
