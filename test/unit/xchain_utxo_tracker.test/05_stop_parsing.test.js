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
const XChainUtxoTracker = require('../../../src/XChainUtxoTracker');
const LevelUpStore = require('../../../src/store/level_up_db');

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

  describe('stopParsing', function () {
    it('resolves when parsingStopped becomes true', async function () {
      tracker.parsingStopped = false;
      // Simulate async stop
      setTimeout(() => { tracker.parsingStopped = true; }, 100);
      const result = await tracker.stopParsing();
      expect(result).to.be.true;
    });

    it('rejects after 10 tries if parsing never stops', async function () {
      tracker.parsingStopped = false;
      sinon.stub(tracker, 'sleep').resolves(); // skip real delays

      try {
        await tracker.stopParsing();
        expect.fail('should have rejected');
      } catch (err) {
        // stopParsing now rejects with an Error and leaves the tracker RUNNING:
        // it restores keepParsing and re-arms the mempool poller so a failed stop
        // is a no-op, not a half-dead tracker that closes its DB on the next loop.
        expect(err.message).to.include('error trying to stop');
        expect(tracker.keepParsing).to.be.true;
      } finally {
        // Clear the re-armed mempool interval so it does not leak past the test.
        if (tracker.mempoolInterval) { clearInterval(tracker.mempoolInterval); tracker.mempoolInterval = null; }
      }
    });
  });
});
