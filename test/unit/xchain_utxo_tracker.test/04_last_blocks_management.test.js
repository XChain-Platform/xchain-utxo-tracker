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
const sinon = require('sinon');
const crypto = require('crypto');
const XChainUtxoTracker = require('../../../src/XChainUtxoTracker');
const LevelUpStore = require('../../../src/store/level_up_db');

// Helpers
function randHash() { return crypto.randomBytes(32).toString('hex'); }

let tracker;
let db;
let mempoolDb;

function registerTrackerHooks() {
  beforeEach(async function () {
    // Create tracker with bitcoin-regtest (needs no real node)
    tracker = new XChainUtxoTracker(
      'bitcoin-regtest', '127.0.0.1', '18443', 'user', 'pass', 'test-db', false
    );

    // Replace dbs with in-memory instances
    db = new LevelUpStore('tracker-test-' + Date.now(), true);
    mempoolDb = new LevelUpStore('mempool-test-' + Date.now(), true);
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
}

describe('XChainUtxoTracker', function () {
  registerTrackerHooks();

  describe('lastBlocks management', function () {
    it('addToLastBlocks adds to array and db', async function () {
      const blockHash = randHash();
      await db.beginTransaction();
      await tracker.addToLastBlocks(blockHash);
      await db.endTransaction(true);

      expect(tracker.lastBlocks).to.include(blockHash);
      const stored = await db.getLastStoredBlocks();
      expect(stored).to.include(blockHash);
    });

    it('addToLastBlocks rejects (not an unhandled rejection) on a malformed block hash', async function () {
      // The db write is now awaited, so a synchronous kStoredBlk guard failure
      // surfaces as a rejected promise the caller can catch rather than an escaped
      // unhandled rejection.
      await db.beginTransaction();
      let threw = false;
      try {
        await tracker.addToLastBlocks('not-a-valid-64-hex-hash');
      } catch (err) {
        threw = true;
        expect(err.message).to.match(/kStoredBlk expects a 64-hex/);
      } finally {
        try { await db.endTransaction(false); } catch (_) {}
      }
      expect(threw, 'expected addToLastBlocks to reject on a malformed hash').to.equal(true);
    });
  });
});

describe('XChainUtxoTracker', function () {
  registerTrackerHooks();

  describe('lastBlocks management', function () {
    it('removeFromLastBlocks removes last element', async function () {
      const h1 = randHash();
      const h2 = randHash();

      await db.beginTransaction();
      await tracker.addToLastBlocks(h1);
      await tracker.addToLastBlocks(h2);
      await db.endTransaction(true);

      await db.beginTransaction();
      await tracker.removeFromLastBlocks(h2);
      await db.endTransaction(true);

      expect(tracker.lastBlocks).to.not.include(h2);
      expect(tracker.lastBlocks).to.include(h1);
    });

    it('removeFromLastBlocks throws if not the last element', async function () {
      const h1 = randHash();
      const h2 = randHash();
      tracker.lastBlocks = [h1, h2];

      try {
        await tracker.removeFromLastBlocks(h1);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.message).to.include("last one");
      }
    });

    it('addToLastBlocks queues cleanup when exceeding UNDO_BLOCKS', async function () {
      // Derive from the tracker's resolved window (Tier-B per-chain, 2026-06-02:
      // bitcoin-regtest → 12) so this stays correct if the default changes again.
      const undo = tracker.undoBlocks;
      await db.beginTransaction();
      for (let i = 0; i < undo + 2; i++) {
        await tracker.addToLastBlocks(randHash());
      }
      await db.endTransaction(true);

      expect(tracker.lastBlocks).to.have.length(undo);
      expect(tracker.pendingKMCleanup).to.have.length(2);
    });
  });
});
