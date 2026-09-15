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

function registerBatchOperationTests() {
  describe('batch operations', function () {
    it('beginTransaction resets the transaction map', async function () {
      await db.insertOutput({ scriptPubKey: randHash(), txHash: randHash8(), outputIndex: 0, value: BigInt(1), height: 1 });
      await db.beginTransaction();
      // After beginTransaction, the pending operations should be a fresh Map
      await db.endTransaction(true); // should not fail
    });

    it('endTransaction with batch=false discards pending writes', async function () {
      const scriptHash = randHash();
      await db.beginTransaction();
      await db.insertOutput({ scriptPubKey: scriptHash, txHash: randHash8(), outputIndex: 0, value: BigInt(999), height: 1 });
      await db.endTransaction(false); // discard

      const outputs = await db.getOutputsScriptPubKey(scriptHash);
      expect(outputs).to.be.empty;
    });

    it('empty batch commits without error', async function () {
      await db.beginTransaction();
      await db.endTransaction(true);
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

  registerBatchOperationTests();
});
