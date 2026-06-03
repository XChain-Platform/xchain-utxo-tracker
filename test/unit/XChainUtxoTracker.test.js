'use strict';

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

      // Insert confirmed output WITHOUT fullTxHash so txid falls back to 16-char prefix
      // (matches the 8-byte key format used by insertInput)
      await db.insertOutput({
        scriptPubKey: scriptHash,
        txHash: txHash8,
        outputIndex: 0,
        value: BigInt('100000000'), // 1 BTC
        height: 400
      });
      await db.endTransaction(true);

      // Insert mempool input spending it — insertInput truncates to first 16 chars
      await mempoolDb.insertInput({
        prevTxHash: txHash8 + '0'.repeat(48), // full 64-char hex, first 16 match txHash8
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

      // Insert output WITHOUT fullTxHash so txid falls back to 16-char prefix
      await db.insertOutput({
        scriptPubKey: scriptHash,
        txHash: txHash8,
        outputIndex: 0,
        value: BigInt('100000000'),
        height: 500
      });
      await db.endTransaction(true);

      // Mempool spends this output — insertInput truncates to 16 chars
      await mempoolDb.insertInput({
        prevTxHash: txHash8 + '0'.repeat(48),
        prevOutputIndex: 0,
        txHash: randHash8()
      });
      await mempoolDb.endTransaction(true);

      const utxos = await tracker.getUtxosAddress(address);
      expect(utxos).to.be.empty;
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
        expect(err).to.include('error trying to stop');
      }
    });
  });
});
