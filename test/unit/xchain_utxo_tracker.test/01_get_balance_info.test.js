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

  describe('getBalanceInfo', function () {
    it('returns confirmed balance with no mempool activity', async function () {
      // We need to use a valid regtest address
      const bitcoin = require('bitcoinjs-lib');
      const { createHash } = require('crypto');
      const address = 'n1wgm6kkzMcNfAtJmes8YhpvtDzdNhDY5a';
      const script = bitcoin.address.toOutputScript(address, tracker.network);
      const scriptHash = createHash('sha256').update(script).digest('hex');

      const txHash8 = randHash8();
      const fullTxHash = randHash();

      // Insert a confirmed output
      await db.insertOutput({
        scriptPubKey: scriptHash,
        txHash: txHash8,
        outputIndex: 0,
        value: BigInt('200000000'), // 2 BTC
        height: 500,
        fullTxHash
      });
      await db.endTransaction(true);

      const info = await tracker.getBalanceInfo(address);
      expect(info.address).to.equal(address);
      expect(info.type).to.equal('p2pkh');
      expect(info.balances.confirmed).to.equal('2.00000000');
      expect(info.balances.pending).to.equal('0.00000000');
      expect(info.utxos.confirmed).to.equal(1);
      expect(info.utxos.pending).to.equal(0);
    });
  });
});

describe('XChainUtxoTracker', function () {
  registerTrackerHooks();

  describe('getBalanceInfo', function () {
    it('reflects pending spend from mempool', async function () {
      const bitcoin = require('bitcoinjs-lib');
      const { createHash } = require('crypto');
      const address = 'n1wgm6kkzMcNfAtJmes8YhpvtDzdNhDY5a';
      const script = bitcoin.address.toOutputScript(address, tracker.network);
      const scriptHash = createHash('sha256').update(script).digest('hex');

      const txHash8 = randHash8();
      // A valid full txid whose first 8 bytes match the O-record key prefix, so
      // the mempool-spend lookup (which keys on the 8-byte prefix) still matches.
      // A pre-migration record without fullTxHash is now rejected by the
      // fail-loud guard, so a migrated record is required to exercise this path.
      const fullTxHash = txHash8 + '0'.repeat(48);

      await db.insertOutput({
        scriptPubKey: scriptHash,
        txHash: txHash8,
        outputIndex: 0,
        value: BigInt('100000000'), // 1 BTC
        height: 400,
        fullTxHash
      });
      await db.endTransaction(true);

      // Insert mempool input spending it; insertInput keys on the 8-byte prefix
      await mempoolDb.insertInput({
        prevTxHash: fullTxHash,
        prevOutputIndex: 0,
        txHash: randHash8()
      });
      await mempoolDb.endTransaction(true);

      const info = await tracker.getBalanceInfo(address);
      expect(info.balances.confirmed).to.equal('1.00000000');
      expect(info.balances.pending).to.equal('-1.00000000');
      expect(info.utxos.confirmed).to.equal(1);
    });
  });
});

describe('XChainUtxoTracker', function () {
  registerTrackerHooks();

  describe('getBalanceInfo', function () {
    it('includes mempool outputs as pending', async function () {
      const bitcoin = require('bitcoinjs-lib');
      const { createHash } = require('crypto');
      const address = 'n1wgm6kkzMcNfAtJmes8YhpvtDzdNhDY5a';
      const script = bitcoin.address.toOutputScript(address, tracker.network);
      const scriptHash = createHash('sha256').update(script).digest('hex');

      // Insert mempool output only
      await mempoolDb.insertOutput({
        scriptPubKey: scriptHash,
        txHash: randHash8(),
        outputIndex: 0,
        value: BigInt('50000000'), // 0.5 BTC
        height: -1,
        fullTxHash: randHash()
      });
      await mempoolDb.endTransaction(true);

      const info = await tracker.getBalanceInfo(address);
      expect(info.balances.confirmed).to.equal('0.00000000');
      expect(info.balances.pending).to.equal('0.50000000');
      expect(info.utxos.pending).to.equal(1);
    });

    it('returns all zeros for unknown address', async function () {
      const address = 'n1wgm6kkzMcNfAtJmes8YhpvtDzdNhDY5a';

      const info = await tracker.getBalanceInfo(address);
      expect(info.balances.confirmed).to.equal('0.00000000');
      expect(info.balances.pending).to.equal('0.00000000');
      expect(info.utxos.confirmed).to.equal(0);
      expect(info.utxos.pending).to.equal(0);
    });
  });
});
