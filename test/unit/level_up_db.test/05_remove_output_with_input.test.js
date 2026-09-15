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

function registerRemoveOutputWithInputTests() {
  describe('removeOutputWithInput', function () {
    it('removes a committed output and stages K/M records', async function () {
      const scriptHash = randHash();
      const txHash8 = randHash8();
      const blockHash = randHash();

      // Insert output + hint, commit
      await db.insertOutput({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 0, value: BigInt(5000), height: 10 });
      await db.insertOutputHint({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 0 });
      await db.endTransaction(true);

      await db.beginTransaction();
      await db.removeOutputWithInput({ prevTxHash: txHash8, prevOutputIndex: 0, blockHash });
      await db.endTransaction(true);

      const outputs = await db.getOutputsScriptPubKey(scriptHash);
      expect(outputs).to.be.empty;
    });

    it('removes an in-memory (same-batch) output', async function () {
      const scriptHash = randHash();
      const txHash8 = randHash8();
      const blockHash = randHash();

      // Insert output + hint and spend it all in the same in-flight batch (not committed).
      // Insert output + hint in same batch (not committed)
      await db.beginTransaction();
      await db.insertOutput({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 0, value: BigInt(1000), height: 5 });
      await db.insertOutputHint({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 0 });
      await db.removeOutputWithInput({ prevTxHash: txHash8, prevOutputIndex: 0, blockHash });
      await db.endTransaction(true);

      const outputs = await db.getOutputsScriptPubKey(scriptHash);
      expect(outputs).to.be.empty;
    });

    it('logs warning for missing output hint (pre-REMOVE_SPENT data)', async function () {
      const txHash8 = randHash8();
      const blockHash = randHash();

      await db.beginTransaction();
      // No output or hint exists; should not throw
      const result = await db.removeOutputWithInput({ prevTxHash: txHash8, prevOutputIndex: 0, blockHash });
      expect(result).to.be.true;
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

  registerRemoveOutputWithInputTests();
});
