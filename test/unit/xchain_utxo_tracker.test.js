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
const XChainUtxoTracker = require('../../src/XChainUtxoTracker');
const LevelUpStore = require('../../src/store/level_up_db');

// Helpers
function randHash() { return crypto.randomBytes(32).toString('hex'); }

// Create a minimal mock transaction (mirrors bitcoinjs-lib Transaction shape)
function makeTx(opts = {}) {
  const txid = opts.txid || randHash();
  const ins = opts.ins || [];
  const outs = opts.outs || [];
  return {
    getId() { return txid; },
    ins,
    outs
  };
}

function makeOutput(valueSats = 100000000) {
  return {
    value: BigInt(valueSats),
    script: crypto.randomBytes(25)
  };
}

function makeCoinbaseInput() {
  return {
    hash: Buffer.alloc(32, 0),
    index: 4294967295, // 0xFFFFFFFF
    script: Buffer.alloc(4)
  };
}

function makeSpendInput(prevTxIdHex, prevVout = 0) {
  // In bitcoinjs-lib, input.hash is in internal byte order (reversed from display txid).
  // The tracker code does Buffer.from(nextInput.hash).reverse() to get the display txid.
  // So we store the reversed bytes (wire order) so that reversal gives back the original hex.
  const hashBuf = Buffer.from(prevTxIdHex, 'hex').reverse();
  return {
    hash: hashBuf,
    index: prevVout,
    script: Buffer.alloc(0)
  };
}

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

  describe('constructor', function () {
    it('sets up network and connector', function () {
      expect(tracker.network).to.exist;
      expect(tracker.connector).to.exist;
      expect(tracker.synced).to.be.false;
      expect(tracker.auxPow).to.be.false;
    });

    it('forces auxPow on for a dogecoin network regardless of the passed flag', function () {
      const dogeTracker = new XChainUtxoTracker(
        'dogecoin-regtest', '127.0.0.1', '18443', 'user', 'pass', 'test-db', false
      );
      expect(dogeTracker.auxPow).to.be.true;
    });

    // BTC/LTC carry no AuxPoW section, so the strip path must be
    // unreachable for them no matter what the caller or AUX_POW says.
    it('forces auxPow off for a non-dogecoin network regardless of the passed flag', function () {
      const btcTracker = new XChainUtxoTracker(
        'bitcoin-regtest', '127.0.0.1', '18443', 'user', 'pass', 'test-db', true
      );
      expect(btcTracker.auxPow).to.be.false;

      const ltcTracker = new XChainUtxoTracker(
        'litecoin-regtest', '127.0.0.1', '18443', 'user', 'pass', 'test-db', true
      );
      expect(ltcTracker.auxPow).to.be.false;
    });

    it('throws for an unresolvable network name instead of decoding under a default network', function () {
      expect(() => new XChainUtxoTracker(
        'not-a-real-network', '127.0.0.1', '18443', 'user', 'pass', 'test-db', false
      // Spans both refusals: getBitcoinJsNetwork's own TypeError ("Unknown
      // network: ...", item 5879) and the constructor's `net`-object backstop.
      )).to.throw(/[Uu]nknown network/);
    });
  });
});

describe('XChainUtxoTracker', function () {
  registerTrackerHooks();

  describe('isSynced', function () {
    it('returns false initially', function () {
      expect(tracker.isSynced()).to.be.false;
    });

    it('returns true when set', function () {
      tracker.synced = true;
      expect(tracker.isSynced()).to.be.true;
    });
  });

  describe('getAddressType', function () {
    it('detects P2PKH address', function () {
      // Bitcoin regtest P2PKH starts with m or n
      const type = tracker.getAddressType('n1wgm6kkzMcNfAtJmes8YhpvtDzdNhDY5a', tracker.network);
      expect(type).to.equal('p2pkh');
    });

    it('detects P2WPKH (bech32) address', function () {
      // Regtest bech32: bcrt1q...
      const type = tracker.getAddressType('bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080', tracker.network);
      expect(type).to.equal('p2wpkh');
    });

    it('returns unknown for invalid address', function () {
      const type = tracker.getAddressType('notanaddress', tracker.network);
      expect(type).to.equal('unknown');
    });
  });
});

describe('XChainUtxoTracker', function () {
  registerTrackerHooks();

  describe('millisecondsToTimeString', function () {
    it('formats hours, minutes, seconds', function () {
      const str = tracker.millisecondsToTimeString(3661500); // 1h 1m 1.5s
      expect(str).to.include('01h');
      expect(str).to.include('01m');
      expect(str).to.include('01.');
    });

    it('includes days for large values', function () {
      const str = tracker.millisecondsToTimeString(2 * 86400000); // 2 days
      expect(str).to.include('2d');
    });
  });
});

describe('XChainUtxoTracker', function () {
  registerTrackerHooks();

  describe('parseTxOutputs', function () {
    it('inserts all outputs for a transaction', async function () {
      const tx = makeTx({
        outs: [makeOutput(50000000), makeOutput(30000000)]
      });
      const blockHash = randHash();

      await db.beginTransaction();
      const count = await tracker.parseTxOutputs(db, tx, blockHash, 100, false, true);
      await db.endTransaction(true);

      expect(count).to.equal(2);
    });

    it('inserts output hints when removeSpent=true', async function () {
      const tx = makeTx({ outs: [makeOutput(1000)] });
      const blockHash = randHash();

      await db.beginTransaction();
      await tracker.parseTxOutputs(db, tx, blockHash, 50, false, true);
      await db.endTransaction(true);

      // Verify output was stored by querying the scriptPubKey
      const scriptHash = crypto.createHash('sha256').update(tx.outs[0].script).digest('hex');
      const outputs = await db.getOutputsScriptPubKey(scriptHash);
      expect(outputs).to.have.length(1);
    });

    it('inserts transaction record when removeSpent=false', async function () {
      const tx = makeTx({ outs: [makeOutput(1000)] });
      const txid = tx.getId();
      const blockHash = randHash();

      await db.beginTransaction();
      await tracker.parseTxOutputs(db, tx, blockHash, 10, false, false);
      await db.endTransaction(true);

      const txs = await db.getTransactions(txid.substring(0, 16));
      expect(txs).to.have.length(1);
      expect(txs[0].block_hash).to.equal(blockHash);
    });

    it('does NOT insert transaction record when removeSpent=true', async function () {
      const tx = makeTx({ outs: [makeOutput(1000)] });
      const txid = tx.getId();
      const blockHash = randHash();

      await db.beginTransaction();
      await tracker.parseTxOutputs(db, tx, blockHash, 10, false, true);
      await db.endTransaction(true);

      const txs = await db.getTransactions(txid.substring(0, 16));
      expect(txs).to.be.empty;
    });
  });
});

describe('XChainUtxoTracker', function () {
  registerTrackerHooks();

  describe('parseTxInputs', function () {
    it('skips coinbase inputs', async function () {
      const tx = makeTx({ ins: [makeCoinbaseInput()] });

      await db.beginTransaction();
      const count = await tracker.parseTxInputs(db, tx, randHash(), false, true);
      await db.endTransaction(true);

      expect(count).to.equal(0);
    });

    it('processes regular inputs with removeSpent=false', async function () {
      const prevTxId = randHash();
      const tx = makeTx({
        ins: [makeSpendInput(prevTxId, 0)]
      });

      await db.beginTransaction();
      const count = await tracker.parseTxInputs(db, tx, randHash(), false, false);
      await db.endTransaction(true);

      expect(count).to.equal(1);
      // makeSpendInput stores hash in internal byte order (reversed).
      // parseTxInputs calls .reverse() to get display txid, then .substring(0,16).
      // So the stored key uses the original prevTxId's first 16 chars.
      const input = await db.getInput(prevTxId.substring(0, 16), 0);
      expect(input).to.not.be.null;
    });
  });
});

describe('XChainUtxoTracker', function () {
  registerTrackerHooks();

  describe('two-pass processing (same-block spend)', function () {
    it('handles tx spending output from earlier tx in same block', async function () {
      const tx1Id = randHash();
      const tx1 = makeTx({
        txid: tx1Id,
        ins: [makeCoinbaseInput()],
        outs: [makeOutput(5000000000)]
      });

      // tx2 spends tx1's output 0
      const tx2 = makeTx({
        ins: [makeSpendInput(tx1Id, 0)],
        outs: [makeOutput(4999990000)]
      });

      const blockHash = randHash();

      await db.beginTransaction();

      // Pass 1: all outputs
      await tracker.parseTxOutputs(db, tx1, blockHash, 200, false, true);
      await tracker.parseTxOutputs(db, tx2, blockHash, 200, false, true);

      // Pass 2: all inputs (tx1's output is now in transactionArray)
      await tracker.parseTxInputs(db, tx1, blockHash, false, true);
      const inputCount = await tracker.parseTxInputs(db, tx2, blockHash, false, true);

      await db.endTransaction(true);

      expect(inputCount).to.equal(1);

      // tx1's output should be removed (spent)
      const tx1Script = crypto.createHash('sha256').update(tx1.outs[0].script).digest('hex');
      const tx1Outputs = await db.getOutputsScriptPubKey(tx1Script);
      expect(tx1Outputs).to.be.empty;

      // tx2's output should exist
      const tx2Script = crypto.createHash('sha256').update(tx2.outs[0].script).digest('hex');
      const tx2Outputs = await db.getOutputsScriptPubKey(tx2Script);
      expect(tx2Outputs).to.have.length(1);
    });
  });
});
