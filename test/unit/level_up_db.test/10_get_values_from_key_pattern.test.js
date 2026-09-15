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

function registerKeyPatternTests() {
  describe('getValuesFromKeyPattern', function () {
    it('scans by key prefix', async function () {
      const scriptHash = randHash();
      const txHash8 = randHash8();
      await db.insertOutput({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 0, value: BigInt(100), height: 1 });
      await db.endTransaction(true);

      // Output key starts with 0x4F + scriptHash
      const pattern = '4f' + scriptHash;
      const results = await db.getValuesFromKeyPattern(pattern);
      expect(results).to.have.length(1);
      expect(results[0]).to.have.property('key');
      expect(results[0]).to.have.property('value');
    });

    it('returns empty for non-matching pattern', async function () {
      const results = await db.getValuesFromKeyPattern(randHash());
      expect(results).to.be.empty;
    });

    // Same rangeEnd regression as the O-prefix tests above, exercised
    // through the generic key-pattern path that the API surfaces via
    // get_input_from_key_pattern. Catches future re-reverts even if the
    // O-specific tests above are removed or refactored.
    it('scans across keys whose suffix-byte-after-prefix is 0xFF', async function () {
      const scriptHash = randHash();
      const txFF = 'ff' + randHash8().substring(2);
      await db.insertOutput({ scriptPubKey: scriptHash, txHash: txFF, outputIndex: 0, value: BigInt(100), height: 1 });
      await db.endTransaction(true);

      const results = await db.getValuesFromKeyPattern('4f' + scriptHash);
      expect(results).to.have.length(1);
      expect(results[0].key.toLowerCase()).to.match(new RegExp('^4f' + scriptHash + txFF + '00000000$'));
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

  registerKeyPatternTests();
});
