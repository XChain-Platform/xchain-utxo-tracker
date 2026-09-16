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

// 6. Block height/hash storage boundaries
describe('Boundary: Block height/hash storage', function () {
  let db;

  beforeEach(async function () {
    db = new LevelUpStore('boundary-blk-' + Date.now(), true);
    await db.createDatabase();
  });

  afterEach(async function () {
    try { await db.close(); } catch (e) {}
  });

  it('getLastBlockHeight returns -1 on empty database', async function () {
    expect(await db.getLastBlockHeight()).to.equal(-1);
  });
  it('stores and retrieves height 0', async function () {
    await db.setLastBlockHeight(0);
    await db.endTransaction(true);
    expect(await db.getLastBlockHeight()).to.equal(0);
  });
  it('getLastBlockHash returns null on empty database', async function () {
    expect(await db.getLastBlockHash()).to.be.null;
  });
  it('handles all-zero block hash', async function () {
    const hash = '0'.repeat(64);
    await db.beginTransaction();
    await db.insertBlock({ hash, height: 0, timestamp: 0, previousHash: '0'.repeat(64) });
    await db.endTransaction();

    const block = await db.getBlock(hash);
    expect(block).to.not.be.null;
    expect(block.h).to.equal(0);
  });
  it('handles timestamp 0 correctly', async function () {
    const hash = randHash();
    await db.beginTransaction();
    await db.insertBlock({ hash, height: 0, timestamp: 0, previousHash: '0'.repeat(64) });
    await db.endTransaction();

    const block = await db.getBlock(hash);
    expect(block.t).to.equal(0);
  });
});
