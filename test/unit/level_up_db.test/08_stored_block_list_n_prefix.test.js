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

function registerStoredBlockListTests() {
  describe('stored block list (N prefix)', function () {
    it('adds and retrieves stored blocks', async function () {
      const h1 = randHash();
      const h2 = randHash();
      await db.addLastStoredBlock(h1);
      await db.addLastStoredBlock(h2);
      await db.endTransaction(true);

      const blocks = await db.getLastStoredBlocks();
      expect(blocks).to.include(h1);
      expect(blocks).to.include(h2);
    });

    it('removes a stored block', async function () {
      const h1 = randHash();
      await db.addLastStoredBlock(h1);
      await db.endTransaction(true);

      await db.beginTransaction();
      await db.removeLastStoredBlock(h1);
      await db.endTransaction(true);

      const blocks = await db.getLastStoredBlocks();
      expect(blocks).to.not.include(h1);
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

  registerStoredBlockListTests();
});
