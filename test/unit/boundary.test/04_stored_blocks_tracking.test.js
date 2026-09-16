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
const crypto = require('crypto');
const LevelUpStore = require('../../../src/store/level_up_db');

function randHash() { return crypto.randomBytes(32).toString('hex'); }

// 8. Stored blocks (N prefix) / UNDO_BLOCKS tracking
describe('Boundary: Stored blocks tracking', function () {
  let db;

  beforeEach(async function () {
    db = new LevelUpStore('boundary-stored-' + Date.now(), true);
    await db.createDatabase();
  });

  afterEach(async function () {
    try { await db.close(); } catch (e) {}
  });

  it('round-trips stored block hashes', async function () {
    const hashes = [];
    for (let i = 0; i < 5; i++) hashes.push(randHash());

    await db.beginTransaction();
    for (const h of hashes) await db.addLastStoredBlock(h);
    await db.endTransaction();

    const stored = await db.getLastStoredBlocks();
    expect(stored).to.have.length(5);
    for (const h of hashes) {
      expect(stored).to.include(h);
    }
  });
  it('removeLastStoredBlock removes the block', async function () {
    const hash = randHash();

    await db.beginTransaction();
    await db.addLastStoredBlock(hash);
    await db.endTransaction();

    await db.beginTransaction();
    await db.removeLastStoredBlock(hash);
    await db.endTransaction();

    const stored = await db.getLastStoredBlocks();
    expect(stored).to.not.include(hash);
  });
  it('rejects a wrong-length block hash instead of writing an unmatchable key', async function () {
    const shortHash = 'deadbeef'; // 8 hex chars, not 64

    await db.beginTransaction();
    let threw = false;
    try {
      await db.addLastStoredBlock(shortHash);
    } catch (e) {
      threw = true;
      expect(e.message).to.match(/kStoredBlk expects a 64-hex/);
    }
    expect(threw).to.equal(true);
    await db.endTransaction();

    const stored = await db.getLastStoredBlocks();
    expect(stored).to.not.include(shortHash);
  });
});
