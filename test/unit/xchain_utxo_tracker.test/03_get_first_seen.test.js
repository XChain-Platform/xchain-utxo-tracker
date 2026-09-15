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

  describe('getFirstSeen', function () {
    it('returns first-seen block height from S-prefix', async function () {
      const bitcoin = require('bitcoinjs-lib');
      const { createHash } = require('crypto');
      const address = 'n1wgm6kkzMcNfAtJmes8YhpvtDzdNhDY5a';
      const script = bitcoin.address.toOutputScript(address, tracker.network);
      const scriptHash = createHash('sha256').update(script).digest('hex');

      const blockHash = randHash();

      await db.insertOutputScriptBlock(scriptHash, blockHash, 42);
      await db.endTransaction(true);

      const firstSeen = await tracker.getFirstSeen(address);
      expect(firstSeen).to.not.be.null;
      expect(firstSeen).to.deep.equal({ height: 42 });
    });

    it('returns null for unknown address', async function () {
      const address = 'n1wgm6kkzMcNfAtJmes8YhpvtDzdNhDY5a';
      const firstSeen = await tracker.getFirstSeen(address);
      expect(firstSeen).to.be.null;
    });
  });
});
