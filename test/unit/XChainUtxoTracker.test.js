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
const LevelUpStore = require('../../src/LevelUpDb');

// Helpers
function randHash() { return crypto.randomBytes(32).toString('hex'); }
function randHash8() { return crypto.randomBytes(8).toString('hex'); }

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

describe('XChainUtxoTracker', function () {
  let tracker;
  let db;
  let mempoolDb;

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

  // ─── Constructor ───────────────────────────────────────────────────────

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

    it('leaves auxPow on the caller-supplied flag for a non-dogecoin network', function () {
      const btcTracker = new XChainUtxoTracker(
        'bitcoin-regtest', '127.0.0.1', '18443', 'user', 'pass', 'test-db', true
      );
      expect(btcTracker.auxPow).to.be.true;
    });

    it('throws for an unresolvable network name instead of decoding under a default network', function () {
      expect(() => new XChainUtxoTracker(
        'not-a-real-network', '127.0.0.1', '18443', 'user', 'pass', 'test-db', false
      )).to.throw(/unknown network/);
    });
  });

  // ─── isSynced ──────────────────────────────────────────────────────────

  describe('isSynced', function () {
    it('returns false initially', function () {
      expect(tracker.isSynced()).to.be.false;
    });

    it('returns true when set', function () {
      tracker.synced = true;
      expect(tracker.isSynced()).to.be.true;
    });
  });

  // ─── getAddressType ────────────────────────────────────────────────────

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

  // ─── millisecondsToTimeString ──────────────────────────────────────────

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

  // ─── parseTxOutputs ──────────────────────────────────────────────────────

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

  // ─── parseTxInputs ────────────────────────────────────────────────────────

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

  // ─── Two-pass block processing ────────────────────────────────────────────

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

  // ─── getBalanceInfo ────────────────────────────────────────────────────

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

  // ─── getUtxosAddress ──────────────────────────────────────────────────

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

    it('excludes confirmed UTXOs spent in mempool', async function () {
      const bitcoin = require('bitcoinjs-lib');
      const { createHash } = require('crypto');
      const address = 'n1wgm6kkzMcNfAtJmes8YhpvtDzdNhDY5a';
      const script = bitcoin.address.toOutputScript(address, tracker.network);
      const scriptHash = createHash('sha256').update(script).digest('hex');

      const txHash8 = randHash8();
      // A valid full txid whose first 8 bytes match the O-record key prefix, so
      // the mempool-spend lookup (which truncates to 8 bytes) still matches.
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

  // ─── getFirstSeen ──────────────────────────────────────────────────────

  describe('getFirstSeen', function () {
    it('returns first-seen block height from S-prefix', async function () {
      const bitcoin = require('bitcoinjs-lib');
      const { createHash } = require('crypto');
      const address = 'n1wgm6kkzMcNfAtJmes8YhpvtDzdNhDY5a';
      const script = bitcoin.address.toOutputScript(address, tracker.network);
      const scriptHash = createHash('sha256').update(script).digest('hex');

      const blockHash = randHash();

      await db.insertOutputScriptBlock(scriptHash, blockHash, 42);
      await db.endTransaction(true);

      const firstSeen = await tracker.getFirstSeen(address);
      expect(firstSeen).to.not.be.null;
      expect(firstSeen).to.deep.equal({ height: 42 });
    });

    it('returns null for unknown address', async function () {
      const address = 'n1wgm6kkzMcNfAtJmes8YhpvtDzdNhDY5a';
      const firstSeen = await tracker.getFirstSeen(address);
      expect(firstSeen).to.be.null;
    });
  });

  // ─── addToLastBlocks / removeFromLastBlocks ────────────────────────────

  describe('lastBlocks management', function () {
    it('addToLastBlocks adds to array and db', async function () {
      const blockHash = randHash();
      await db.beginTransaction();
      await tracker.addToLastBlocks(blockHash);
      await db.endTransaction(true);

      expect(tracker.lastBlocks).to.include(blockHash);
      const stored = await db.getLastStoredBlocks();
      expect(stored).to.include(blockHash);
    });

    it('removeFromLastBlocks removes last element', async function () {
      const h1 = randHash();
      const h2 = randHash();

      await db.beginTransaction();
      await tracker.addToLastBlocks(h1);
      await tracker.addToLastBlocks(h2);
      await db.endTransaction(true);

      await db.beginTransaction();
      await tracker.removeFromLastBlocks(h2);
      await db.endTransaction(true);

      expect(tracker.lastBlocks).to.not.include(h2);
      expect(tracker.lastBlocks).to.include(h1);
    });

    it('removeFromLastBlocks throws if not the last element', async function () {
      const h1 = randHash();
      const h2 = randHash();
      tracker.lastBlocks = [h1, h2];

      try {
        await tracker.removeFromLastBlocks(h1);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.message).to.include("last one");
      }
    });

    it('addToLastBlocks queues cleanup when exceeding UNDO_BLOCKS', async function () {
      // Derive from the tracker's resolved window (Tier-B per-chain, 2026-06-02:
      // bitcoin-regtest → 12) so this stays correct if the default changes again.
      const undo = tracker.undoBlocks;
      await db.beginTransaction();
      for (let i = 0; i < undo + 2; i++) {
        await tracker.addToLastBlocks(randHash());
      }
      await db.endTransaction(true);

      expect(tracker.lastBlocks).to.have.length(undo);
      expect(tracker.pendingKMCleanup).to.have.length(2);
    });
  });

  // ─── stopParsing ──────────────────────────────────────────────────────

  describe('stopParsing', function () {
    it('resolves when parsingStopped becomes true', async function () {
      tracker.parsingStopped = false;
      // Simulate async stop
      setTimeout(() => { tracker.parsingStopped = true; }, 100);
      const result = await tracker.stopParsing();
      expect(result).to.be.true;
    });

    it('rejects after 10 tries if parsing never stops', async function () {
      tracker.parsingStopped = false;
      sinon.stub(tracker, 'sleep').resolves(); // skip real delays

      try {
        await tracker.stopParsing();
        expect.fail('should have rejected');
      } catch (err) {
        // stopParsing now rejects with an Error and leaves the tracker RUNNING:
        // it restores keepParsing and re-arms the mempool poller so a failed stop
        // is a no-op, not a half-dead tracker that closes its DB on the next loop.
        expect(err.message).to.include('error trying to stop');
        expect(tracker.keepParsing).to.be.true;
      } finally {
        // Clear the re-armed mempool interval so it does not leak past the test.
        if (tracker.mempoolInterval) { clearInterval(tracker.mempoolInterval); tracker.mempoolInterval = null; }
      }
    });
  });
});
