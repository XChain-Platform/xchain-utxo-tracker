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

function registerInputOperationTests() {
  describe('input operations (I prefix)', function () {
    it('inserts and retrieves an input', async function () {
      const prevTxHash = randHash();
      const spendingTxHash8 = randHash8();
      await db.insertInput({ prevTxHash, prevOutputIndex: 0, txHash: spendingTxHash8 });
      await db.endTransaction(true);

      const input = await db.getInput(prevTxHash.substring(0, 16), 0);
      expect(input).to.not.be.null;
    });

    it('returns null for unspent output', async function () {
      const result = await db.getInput(randHash8(), 0);
      expect(result).to.be.null;
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

  registerInputOperationTests();
});
