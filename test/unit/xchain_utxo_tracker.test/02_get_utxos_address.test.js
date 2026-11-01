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
const sinon = require('sinon');
const crypto = require('crypto');
const XChainUtxoTracker = require('../../../src/XChainUtxoTracker');
const LevelUpStore = require('../../../src/store/level_up_db');

// Helpers
function randHash() { return crypto.randomBytes(32).toString('hex'); }
function randHash8() { return crypto.randomBytes(8).toString('hex'); }

let tracker;
let db;
let mempoolDb;

function registerTrackerHooks() {
  beforeEach(async function () {
    // Create tracker with bitcoin-regtest (needs no real node)
    tracker = new XChainUtxoTracker(
      'bitcoin-regtest', '127.0.0.1', '18443', 'user', 'pass', 'test-db', false
    );

    // Replace dbs with in-memory instances
    db = new LevelUpStore('tracker-test-' + Date.now(), true);
    mempoolDb = new LevelUpStore('mempool-test-' + Date.now(), true);
    await db.createDatabase();
    await mempoolDb.createDatabase();
    tracker.db = db;
    tracker.mempoolDb = mempoolDb;
    tracker.blockchainInfoLastBlock = 1000;
  });

  afterEach(async function () {
    sinon.restore();
    try { await db.close(); } catch (e) {}
    try { await mempoolDb.close(); } catch (e) {}
  });
}

describe('XChainUtxoTracker', function () {
  registerTrackerHooks();

  describe('getUtxosAddress', function () {
    it('returns confirmed UTXOs with correct fields', async function () {
      const bitcoin = require('bitcoinjs-lib');
      const { createHash } = require('crypto');
      const address = 'n1wgm6kkzMcNfAtJmes8YhpvtDzdNhDY5a';
      const script = bitcoin.address.toOutputScript(address, tracker.network);
      const scriptHash = createHash('sha256').update(script).digest('hex');

      const fullTxHash = randHash();
      const txidHex = fullTxHash;

      await db.insertOutput({
        scriptPubKey: scriptHash,
        txHash: txidHex,
        outputIndex: 2,
        value: BigInt('300000000'),
        height: 900,
        fullTxHash
      });
      await db.endTransaction(true);

      const utxos = await tracker.getUtxosAddress(address);
      expect(utxos).to.have.length(1);
      expect(utxos[0].txid).to.equal(fullTxHash);
      expect(utxos[0].vout).to.equal(2);
      expect(utxos[0].confirmations).to.equal(1000 - 900 + 1);
      expect(utxos[0].amount).to.equal('3.00000000'); // 300000000 sat, exact BigInt decimal string
    });
  });
});

describe('XChainUtxoTracker', function () {
  registerTrackerHooks();

  describe('getUtxosAddress', function () {
    it('excludes confirmed UTXOs spent in mempool', async function () {
      const bitcoin = require('bitcoinjs-lib');
      const { createHash } = require('crypto');
      const address = 'n1wgm6kkzMcNfAtJmes8YhpvtDzdNhDY5a';
      const script = bitcoin.address.toOutputScript(address, tracker.network);
      const scriptHash = createHash('sha256').update(script).digest('hex');

      const txidHex = randHash();
      // The O key and value carry the same full txid (see the "reflects pending
      // spend from mempool" test above).
      const fullTxHash = txidHex;

      await db.insertOutput({
        scriptPubKey: scriptHash,
        txHash: txidHex,
        outputIndex: 0,
        value: BigInt('100000000'),
        height: 500,
        fullTxHash
      });
      await db.endTransaction(true);

      // Mempool spends this output; insertInput keys on the full prev txid
      await mempoolDb.insertInput({
        prevTxHash: fullTxHash,
        prevOutputIndex: 0,
        txHash: randHash()
      });
      await mempoolDb.endTransaction(true);

      const utxos = await tracker.getUtxosAddress(address);
      expect(utxos).to.be.empty;
    });
  });
});

describe('XChainUtxoTracker', function () {
  registerTrackerHooks();

  describe('getUtxosAddress', function () {
    it('serves the full txid from the key for a record whose value lacks fullTxHash', async function () {
      const bitcoin = require('bitcoinjs-lib');
      const { createHash } = require('crypto');
      const address = 'n1wgm6kkzMcNfAtJmes8YhpvtDzdNhDY5a';
      const script = bitcoin.address.toOutputScript(address, tracker.network);
      const scriptHash = createHash('sha256').update(script).digest('hex');

      // Output written WITHOUT a fullTxHash. The zero-hash sentinel decodes to
      // fullTxid: null; the O key carries the whole txid, so that is served.
      // In store layout 2 no record can resolve to a shorter id, so the guard
      // in requireFullTxid never fires for a record the store wrote.
      const txid = randHash();
      await db.insertOutput({
        scriptPubKey: scriptHash,
        txHash: txid,
        outputIndex: 0,
        value: BigInt('100000000'),
        height: 500
      });
      await db.endTransaction(true);

      const utxos = await tracker.getUtxosAddress(address);
      expect(utxos.map((u) => u.txid)).to.deep.equal([txid]);
    });
  });
});

describe('XChainUtxoTracker', function () {
  registerTrackerHooks();

  describe('getUtxosAddress', function () {
    it('includes mempool UTXOs', async function () {
      const bitcoin = require('bitcoinjs-lib');
      const { createHash } = require('crypto');
      const address = 'n1wgm6kkzMcNfAtJmes8YhpvtDzdNhDY5a';
      const script = bitcoin.address.toOutputScript(address, tracker.network);
      const scriptHash = createHash('sha256').update(script).digest('hex');

      await mempoolDb.insertOutput({
        scriptPubKey: scriptHash,
        txHash: randHash(),
        outputIndex: 0,
        value: BigInt('25000000'),
        height: -1,
        fullTxHash: randHash()
      });
      await mempoolDb.endTransaction(true);

      const utxos = await tracker.getUtxosAddress(address);
      expect(utxos).to.have.length(1);
      expect(utxos[0].confirmations).to.equal(0);
      expect(utxos[0].height).to.be.null;
    });
  });
});
