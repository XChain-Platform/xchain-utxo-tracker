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

function registerScriptBlockTrackingTests() {
  // S records when an address was first seen and Z tracks which blocks touched
  // it, so a per-address query does not have to walk every block.
  describe('script block tracking (S/Z prefix)', function () {
    it('records first appearance and retrieves it', async function () {
      const scriptHash = randHash();
      const blockHash = randHash();

      await db.insertOutputScriptBlock(scriptHash, blockHash, 100);
      await db.endTransaction(true);

      const result = await db.getOutputScriptBlock(scriptHash);
      expect(result).to.not.be.null;
      expect(result.h).to.equal(100);
    });

    it('does not overwrite first appearance', async function () {
      const scriptHash = randHash();
      const firstBlock = randHash();
      const secondBlock = randHash();

      await db.insertOutputScriptBlock(scriptHash, firstBlock, 50);
      await db.insertOutputScriptBlock(scriptHash, secondBlock, 100);
      await db.endTransaction(true);

      const result = await db.getOutputScriptBlock(scriptHash);
      expect(result.h).to.equal(50);
    });

    it('returns null for unknown script', async function () {
      expect(await db.getOutputScriptBlock(randHash())).to.be.null;
    });

    it('skips insertion when blockHash is falsy (mempool)', async function () {
      const scriptHash = randHash();
      await db.insertOutputScriptBlock(scriptHash, null, -1);
      await db.endTransaction(true);
      expect(await db.getOutputScriptBlock(scriptHash)).to.be.null;
    });

    it('removeOutputScriptsInBlock cleans up S and Z entries', async function () {
      const scriptHash = randHash();
      const blockHash = randHash();

      await db.insertOutputScriptBlock(scriptHash, blockHash, 10);
      await db.endTransaction(true);

      // Verify exists
      expect(await db.getOutputScriptBlock(scriptHash)).to.not.be.null;

      // Remove
      await db.beginTransaction();
      await db.removeOutputScriptsInBlock(blockHash);
      await db.endTransaction(true);

      expect(await db.getOutputScriptBlock(scriptHash)).to.be.null;
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

  registerScriptBlockTrackingTests();
});
