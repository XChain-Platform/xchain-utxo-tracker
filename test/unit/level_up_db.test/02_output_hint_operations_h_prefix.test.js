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

function registerOutputHintOperationTests() {
  // An H key is a reverse index: given an output, which input spent it. It is
  // what lets a spend be undone without rescanning the chain.
  describe('output hint operations (H prefix)', function () {
    it('inserts output hint and deletes outputs by hint', async function () {
      const scriptHash = randHash();
      const txHash8 = randHash8();
      const fullTxHash = txHash8 + randHash().substring(16);

      await db.insertOutput({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 0, value: BigInt(1000), height: 1 });
      await db.insertOutputHint({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 0 });
      await db.endTransaction(true);

      // Verify output exists
      let outputs = await db.getOutputsScriptPubKey(scriptHash);
      expect(outputs).to.have.length(1);

      // Delete by hint
      await db.beginTransaction();
      const deleted = await db.deleteOutputsByHint(fullTxHash);
      await db.endTransaction(true);

      expect(deleted).to.equal(1);
      outputs = await db.getOutputsScriptPubKey(scriptHash);
      expect(outputs).to.be.empty;
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

  registerOutputHintOperationTests();
});
