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
const LevelUpStore = require('../../src/store/level_up_db');
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

function registerBlockHeightAndHashTests() {
  describe('block height and hash', function () {
    it('getLastBlockHeight returns -1 when empty', async function () {
      expect(await db.getLastBlockHeight()).to.equal(-1);
    });

    it('round-trips block height', async function () {
      await db.setLastBlockHeight(500);
      await db.endTransaction(true);
      expect(await db.getLastBlockHeight()).to.equal(500);
    });

    it('getLastBlockHash returns null when empty', async function () {
      expect(await db.getLastBlockHash()).to.be.null;
    });

    it('round-trips block hash', async function () {
      const hash = randHash();
      await db.setLastBlockHash(hash);
      await db.endTransaction(true);
      expect(await db.getLastBlockHash()).to.equal(hash);
    });
  });
}

function registerBlockOperationTests() {
  // B keys hold one record per block: its hash, height and the data the
  // rollback path needs to unwind it.
  describe('block operations (B prefix)', function () {
    it('inserts and retrieves a block', async function () {
      const hash = randHash();
      const prevHash = randHash();
      await db.insertBlock({ hash, height: 100, timestamp: 1700000000, previousHash: prevHash });
      await db.endTransaction(true);

      const block = await db.getBlock(hash);
      expect(block).to.not.be.null;
      expect(block.h).to.equal(100);
      expect(block.t).to.equal(1700000000);
      expect(block.ph).to.equal(prevHash);
    });

    it('returns null for non-existent block', async function () {
      expect(await db.getBlock(randHash())).to.be.null;
    });

    it('deletes a block', async function () {
      const hash = randHash();
      await db.insertBlock({ hash, height: 1, timestamp: 1, previousHash: randHash() });
      await db.endTransaction(true);

      await db.beginTransaction();
      await db.deleteBlock(hash);
      await db.endTransaction(true);

      expect(await db.getBlock(hash)).to.be.null;
    });

    it('getLastBlock returns highest block', async function () {
      const h1 = randHash();
      const h2 = randHash();
      await db.insertBlock({ hash: h1, height: 10, timestamp: 1, previousHash: randHash() });
      await db.insertBlock({ hash: h2, height: 20, timestamp: 2, previousHash: h1 });
      await db.endTransaction(true);

      const last = await db.getLastBlock();
      expect(last.height).to.equal(20);
      expect(last.hash).to.equal(h2);
    });

    it('getLastBlock returns null on empty db', async function () {
      expect(await db.getLastBlock()).to.be.null;
    });
  });
}

function registerTransactionOperationTests() {

  // T keys hold one record per transaction, keyed by the first eight bytes of
  // its hash. The full hash is stored in the value, because eight bytes can
  // collide and the reader has to be able to tell.
  describe('transaction operations (T prefix)', function () {
    it('inserts and retrieves a transaction', async function () {
      const txHash = randHash();
      const blockHash = randHash();
      await db.insertTransaction({ hash: txHash, blockHash });
      await db.endTransaction(true);

      const txs = await db.getTransactions(txHash.substring(0, 16));
      expect(txs).to.have.length(1);
      expect(txs[0].block_hash).to.equal(blockHash);
    });

    it('returns empty array for unknown tx prefix', async function () {
      const txs = await db.getTransactions(randHash8());
      expect(txs).to.be.an('array').that.is.empty;
    });

    it('deletes a transaction', async function () {
      const txHash = randHash();
      await db.insertTransaction({ hash: txHash, blockHash: randHash() });
      await db.endTransaction(true);

      await db.beginTransaction();
      await db.deleteTransaction(txHash);
      await db.endTransaction(true);

      const txs = await db.getTransactions(txHash.substring(0, 16));
      expect(txs).to.be.empty;
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

  registerBlockHeightAndHashTests();
  registerBlockOperationTests();
  registerTransactionOperationTests();
});
