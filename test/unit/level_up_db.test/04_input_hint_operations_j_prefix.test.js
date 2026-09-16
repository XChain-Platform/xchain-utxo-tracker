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
const LevelUpStore = require('../../../src/store/level_up_db');
const crypto = require('crypto');

// Helper: generate a random 32-byte hex string (64 chars)
function randHash() {
  return crypto.randomBytes(32).toString('hex');
}
// Helper: generate a random 8-byte hex string (16 chars)
function randHash8() {
  return crypto.randomBytes(8).toString('hex');
}

let db;

function registerInputHintOperationTests() {
  // A J key is the same idea pointing the other way: given an input, which
  // output it consumed.
  describe('input hint operations (J prefix)', function () {
    it('inserts input hint and deletes inputs by hint', async function () {
      const prevTxHash = randHash();
      const spendingTxHash8 = randHash8();
      const spendingFullTx = spendingTxHash8 + randHash().substring(16);

      await db.insertInput({ prevTxHash, prevOutputIndex: 0, txHash: spendingTxHash8 });
      await db.insertInputHint({ prevTxHash, prevOutputIndex: 0, txHash: spendingTxHash8 });
      await db.endTransaction(true);

      // Input should exist
      let input = await db.getInput(prevTxHash.substring(0, 16), 0);
      expect(input).to.not.be.null;

      // Delete by hint
      await db.beginTransaction();
      const deleted = await db.deleteInputsByHint(spendingFullTx);
      await db.endTransaction(true);

      expect(deleted).to.equal(1);
      input = await db.getInput(prevTxHash.substring(0, 16), 0);
      expect(input).to.be.null;
    });
  });
}

describe('LevelUpDb', function () {
  beforeEach(async function () {
    db = new LevelUpStore('test-' + Date.now(), true); // in-memory
    await db.createDatabase();
  });

  afterEach(async function () {
    try { await db.close(); } catch (e) { /* already closed */ }
  });

  registerInputHintOperationTests();
});
