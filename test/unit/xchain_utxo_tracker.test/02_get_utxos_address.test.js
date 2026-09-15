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
      const txHash8 = fullTxHash.substring(0, 16);

      await db.insertOutput({
        scriptPubKey: scriptHash,
        txHash: txHash8,
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

      const txHash8 = randHash8();
      // Full txid built from the O-record's 8-byte key prefix (see the
      // "reflects pending spend from mempool" test above for why).
      const fullTxHash = txHash8 + '0'.repeat(48);

      await db.insertOutput({
        scriptPubKey: scriptHash,
        txHash: txHash8,
        outputIndex: 0,
        value: BigInt('100000000'),
        height: 500,
        fullTxHash
      });
      await db.endTransaction(true);

      // Mempool spends this output; insertInput keys on the 8-byte prefix
      await mempoolDb.insertInput({
        prevTxHash: fullTxHash,
        prevOutputIndex: 0,
        txHash: randHash8()
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
    it('throws on a pre-migration record missing its fullTxHash', async function () {
      const bitcoin = require('bitcoinjs-lib');
      const { createHash } = require('crypto');
      const address = 'n1wgm6kkzMcNfAtJmes8YhpvtDzdNhDY5a';
      const script = bitcoin.address.toOutputScript(address, tracker.network);
      const scriptHash = createHash('sha256').update(script).digest('hex');

      // Output written WITHOUT a fullTxHash. The zero-hash sentinel decodes to
      // fullTxid: null, so the resolved txid is only the 16-char key prefix.
      // Such records predate the O-record fullTxHash field and cannot spend
      // validly; getUtxosAddress must reject them rather than emit a truncated id.
      await db.insertOutput({
        scriptPubKey: scriptHash,
        txHash: randHash8(),
        outputIndex: 0,
        value: BigInt('100000000'),
        height: 500
      });
      await db.endTransaction(true);

      let threw = null;
      try {
        await tracker.getUtxosAddress(address);
      } catch (e) {
        threw = e;
      }
      expect(threw).to.not.be.null;
      expect(threw.message).to.match(/fullTxHash/);
      expect(threw.message).to.match(/re-index/i);
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
        txHash: randHash8(),
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
