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

function registerProcessDeletedOutputTests() {
  describe('processDeletedOutputs', function () {
    it('recovers outputs from K/M records', async function () {
      const scriptHash = randHash();
      const txHash8 = randHash8();
      const blockHash = randHash();

      // Insert and commit output
      await db.insertOutput({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 0, value: BigInt(7000), height: 20 });
      await db.insertOutputHint({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 0 });
      await db.endTransaction(true);

      // Spend it (creates K/M records)
      await db.beginTransaction();
      await db.removeOutputWithInput({ prevTxHash: txHash8, prevOutputIndex: 0, blockHash });
      await db.endTransaction(true);

      // Output should be gone
      let outputs = await db.getOutputsScriptPubKey(scriptHash);
      expect(outputs).to.be.empty;

      // Recover
      await db.beginTransaction();
      await db.processDeletedOutputs(blockHash, true);
      await db.endTransaction(true);

      // Output should be back
      outputs = await db.getOutputsScriptPubKey(scriptHash);
      expect(outputs).to.have.length(1);
      expect(outputs[0].value).to.equal('7000');
    });

    it('purges K/M records without recovery when recover=false', async function () {
      const scriptHash = randHash();
      const txHash8 = randHash8();
      const blockHash = randHash();

      await db.insertOutput({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 0, value: BigInt(1000), height: 5 });
      await db.insertOutputHint({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 0 });
      await db.endTransaction(true);

      await db.beginTransaction();
      await db.removeOutputWithInput({ prevTxHash: txHash8, prevOutputIndex: 0, blockHash });
      await db.endTransaction(true);

      // Purge without recovery
      await db.beginTransaction();
      await db.processDeletedOutputs(blockHash, false);
      await db.endTransaction(true);

      const outputs = await db.getOutputsScriptPubKey(scriptHash);
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

  registerProcessDeletedOutputTests();
});
