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

// Regression: immature coinbase outputs must not be served spendable.
//
// Every node rejects a spend of an immature coinbase, so serving one hands the
// caller an input that can never confirm. Coinbase-ness is therefore marked on
// the O-record as an optional 45th byte, which keeps non-coinbase records at 44
// bytes and forces no reindex, and getUtxosAddress withholds any coinbase output
// below its chain's maturity depth.
//
// That depth is per coin/network and resolves in src/coinbase-maturity.js: 100 on
// Bitcoin and Litecoin, 240 on Dogecoin at the tip, 60 on Dogecoin regtest. A
// single flat constant is wrong for at least one live chain in each direction,
// which is what the Dogecoin blocks below pin.

const { expect } = require('chai');
const crypto = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const LevelUpStore = require('../../src/LevelUpDb');
const XChainUtxoTracker = require('../../src/XChainUtxoTracker');

const FULL_TXID_A = 'a'.repeat(64);
const FULL_TXID_B = 'b'.repeat(64);

describe('coinbase maturity', function () {

  describe('O-record coinbase flag round-trips and stays reindex-free', function () {
    let db;
    beforeEach(async function () {
      db = new LevelUpStore('cb-oval-' + Date.now() + '-' + Math.random(), true);
      await db.createDatabase();
    });
    afterEach(async function () { try { await db.close(); } catch (e) {} });

    it('coinbase output decodes coinbase=true; non-coinbase stays 44 bytes and decodes false', async function () {
      const scriptHash = crypto.createHash('sha256').update(Buffer.from('deadbeef', 'hex')).digest('hex');

      await db.insertOutput({ scriptPubKey: scriptHash, txHash: FULL_TXID_A.substring(0, 16), outputIndex: 0, value: BigInt(50), height: 5, fullTxHash: FULL_TXID_A, coinbase: true });
      await db.insertOutput({ scriptPubKey: scriptHash, txHash: FULL_TXID_B.substring(0, 16), outputIndex: 1, value: BigInt(10), height: 5, fullTxHash: FULL_TXID_B, coinbase: false });
      await db.endTransaction(true);

      const outputs = await db.getOutputsScriptPubKey(scriptHash);
      const byTx = Object.fromEntries(outputs.map(o => [o.txid, o]));

      expect(byTx[FULL_TXID_A.substring(0, 16)].coinbase).to.equal(true);
      expect(byTx[FULL_TXID_B.substring(0, 16)].coinbase).to.equal(false);
    });

    it('a legacy 44-byte O-value (written without the coinbase byte) decodes as non-coinbase', async function () {
      // Write the exact legacy 44-byte value directly under the store so the
      // record is byte-identical to what an existing on-disk DB holds. It must
      // read back as coinbase=false with no error (no forced reindex).
      const scriptHash = crypto.createHash('sha256').update(Buffer.from('feedface', 'hex')).digest('hex');
      const legacy = Buffer.alloc(44);
      legacy.writeBigUInt64BE(BigInt(77), 0);
      legacy.writeInt32BE(9, 8);
      Buffer.from(FULL_TXID_A, 'hex').copy(legacy, 12);

      const oKey = Buffer.concat([
        Buffer.from([0x4F]),
        Buffer.from(scriptHash, 'hex'),
        Buffer.from(FULL_TXID_A.substring(0, 16), 'hex'),
        (() => { const b = Buffer.alloc(4); b.writeUInt32BE(0); return b; })()
      ]);
      await db.db.put(oKey, legacy);

      const outputs = await db.getOutputsScriptPubKey(scriptHash);
      expect(outputs).to.have.length(1);
      expect(outputs[0].coinbase).to.equal(false);
      expect(outputs[0].value).to.equal('77');
    });
  });

  describe('getUtxosAddress withholds immature coinbase', function () {
    let tracker, db, mempoolDb, address, scriptHash;

    beforeEach(async function () {
      tracker = new XChainUtxoTracker('bitcoin-regtest', '127.0.0.1', '18443', 'u', 'p', 'cb-mat-db', false);
      db = new LevelUpStore('cb-conf-' + Date.now() + '-' + Math.random(), true);
      mempoolDb = new LevelUpStore('cb-mp-' + Date.now() + '-' + Math.random(), true);
      await db.createDatabase();
      await mempoolDb.createDatabase();
      tracker.db = db;
      tracker.mempoolDb = mempoolDb;

      // A deterministic P2WPKH regtest address and its scriptHash, derived the
      // same way getUtxosAddress does, so the O-key matches on read.
      const pubkeyHash = crypto.createHash('sha256').update(Buffer.from('coinbase-maturity-fixture')).digest().subarray(0, 20);
      const payment = bitcoin.payments.p2wpkh({ hash: pubkeyHash, network: tracker.network });
      address = payment.address;
      const script = bitcoin.address.toOutputScript(address, tracker.network);
      scriptHash = crypto.createHash('sha256').update(script).digest('hex');
    });

    afterEach(async function () {
      try { await db.close(); } catch (e) {}
      try { await mempoolDb.close(); } catch (e) {}
    });

    async function insertOutputForAddress(fullTxid, vout, height, coinbase) {
      await db.insertOutput({ scriptPubKey: scriptHash, txHash: fullTxid.substring(0, 16), outputIndex: vout, value: BigInt(5000000000), height, fullTxHash: fullTxid, coinbase });
      await db.endTransaction(true);
      await db.beginTransaction();
    }

    it('withholds a coinbase output below maturity but serves a mature one and a non-coinbase one', async function () {
      tracker.coinbaseMaturity = 100;
      tracker.blockchainInfoLastBlock = 150;

      // height 60 -> 91 confs -> immature (withheld)
      await insertOutputForAddress(FULL_TXID_A, 0, 60, true);
      // height 40 -> 111 confs -> mature (served)
      await insertOutputForAddress(FULL_TXID_B, 0, 40, true);
      // non-coinbase at height 60 -> served regardless of confs
      await insertOutputForAddress('c'.repeat(64), 0, 60, false);

      const utxos = await tracker.getUtxosAddress(address);
      const txids = utxos.map(u => u.txid).sort();

      expect(txids).to.deep.equal([FULL_TXID_B, 'c'.repeat(64)].sort());
      expect(txids).to.not.include(FULL_TXID_A);
    });

    it('coinbaseMaturity = 0 disables the gate (matches the behaviour before the maturity check was added)', async function () {
      tracker.coinbaseMaturity = 0;
      tracker.blockchainInfoLastBlock = 60;

      await insertOutputForAddress(FULL_TXID_A, 0, 60, true); // 1 conf, immature, but gate off

      const utxos = await tracker.getUtxosAddress(address);
      expect(utxos.map(u => u.txid)).to.include(FULL_TXID_A);
    });
  });

  // The per-chain half of the same rule. This block deliberately never assigns
  // tracker.coinbaseMaturity: the depth under test is the one the CONSTRUCTOR
  // resolved, so a reversion to any flat constant turns the 150-confirmation case
  // red. Against the old flat 100 the first case failed outright, serving a DOGE
  // coinbase Dogecoin rejects as immature.
  describe('Dogecoin maturity is 240 at the tip, not Bitcoin\'s 100', function () {
    let tracker, db, mempoolDb, address, scriptHash;

    beforeEach(async function () {
      tracker = new XChainUtxoTracker('dogecoin-mainnet', '127.0.0.1', '22555', 'u', 'p', 'cb-mat-doge-db', false);
      db = new LevelUpStore('cb-doge-' + Date.now() + '-' + Math.random(), true);
      mempoolDb = new LevelUpStore('cb-doge-mp-' + Date.now() + '-' + Math.random(), true);
      await db.createDatabase();
      await mempoolDb.createDatabase();
      tracker.db = db;
      tracker.mempoolDb = mempoolDb;

      // P2PKH, not P2WPKH: Dogecoin has no segwit and no bech32 addresses.
      const pubkeyHash = crypto.createHash('sha256').update(Buffer.from('doge-coinbase-maturity-fixture')).digest().subarray(0, 20);
      address = bitcoin.payments.p2pkh({ hash: pubkeyHash, network: tracker.network }).address;
      const script = bitcoin.address.toOutputScript(address, tracker.network);
      scriptHash = crypto.createHash('sha256').update(script).digest('hex');
    });

    afterEach(async function () {
      try { await db.close(); } catch (e) {}
      try { await mempoolDb.close(); } catch (e) {}
    });

    async function insertCoinbaseAt(fullTxid, height) {
      await db.insertOutput({ scriptPubKey: scriptHash, txHash: fullTxid.substring(0, 16), outputIndex: 0, value: BigInt(1000000000000), height, fullTxHash: fullTxid, coinbase: true });
      await db.endTransaction(true);
      await db.beginTransaction();
    }

    it('resolves 240 at construction', function () {
      expect(tracker.coinbaseMaturity).to.equal(240);
    });

    it('withholds a DOGE coinbase at 150 confirmations, which a flat 100 served', async function () {
      tracker.blockchainInfoLastBlock = 1000000;
      // height 999851 -> 150 confs: mature under a flat 100, immature on DOGE.
      await insertCoinbaseAt(FULL_TXID_A, 999851);

      const utxos = await tracker.getUtxosAddress(address);
      expect(utxos.map(u => u.txid)).to.not.include(FULL_TXID_A);
    });

    it('serves the same output once it reaches 240 confirmations', async function () {
      tracker.blockchainInfoLastBlock = 1000000;
      // height 999761 -> 240 confs: the first depth Dogecoin accepts.
      await insertCoinbaseAt(FULL_TXID_B, 999761);

      const utxos = await tracker.getUtxosAddress(address);
      expect(utxos.map(u => u.txid)).to.include(FULL_TXID_B);
    });
  });

  // Dogecoin regtest is 60, LOWER than the old flat 100, so the flat value was
  // withholding coinbase a regtest node would have accepted. Pinned because a
  // harness that mines exactly to depth depends on the real number.
  describe('Dogecoin regtest maturity is 60', function () {
    it('resolves 60 at construction', function () {
      const t = new XChainUtxoTracker('dogecoin-regtest', '127.0.0.1', '18332', 'u', 'p', 'cb-mat-doge-rt-db', false);
      expect(t.coinbaseMaturity).to.equal(60);
    });
  });

  describe('isCoinbaseTransaction', function () {
    it('flags a single 0xFFFFFFFF-index input as coinbase', function () {
      expect(XChainUtxoTracker.isCoinbaseTransaction({ ins: [{ index: 4294967295 }] })).to.equal(true);
    });
    it('does not flag an ordinary spend', function () {
      expect(XChainUtxoTracker.isCoinbaseTransaction({ ins: [{ index: 0 }] })).to.equal(false);
    });
    it('does not flag a multi-input tx even if one input looks coinbase-like', function () {
      expect(XChainUtxoTracker.isCoinbaseTransaction({ ins: [{ index: 4294967295 }, { index: 0 }] })).to.equal(false);
    });
  });
});
