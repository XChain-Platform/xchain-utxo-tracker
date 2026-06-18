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

const crypto = require('crypto');
const { createHash } = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');
const sinon = require('sinon');
const bitcoin = require('bitcoinjs-lib');
const ECPairFactory = require('ecpair');
const ecc = require('tiny-secp256k1');
const express = require('express');
const bodyParser = require('body-parser');
const supertest = require('supertest');
const jsonRouter = require('express-json-rpc-router');

const LevelUpStore = require('../../src/LevelUpDb');
const XChainUtxoTracker = require('../../src/XChainUtxoTracker');

const ECPair = ECPairFactory.ECPairFactory(ecc);
const NETWORK = bitcoin.networks.regtest;
const SATOSHI = 100000000;

// ─── Deterministic test addresses (same as integration helpers) ─────────────

const TEST_KEYS = [];
for (let i = 1; i <= 10; i++) {
  const privKey = createHash('sha256').update('test-key-' + i).digest();
  const keyPair = ECPair.fromPrivateKey(privKey, { network: NETWORK });
  const p2pkh = bitcoin.payments.p2pkh({ pubkey: keyPair.publicKey, network: NETWORK });
  const script = bitcoin.address.toOutputScript(p2pkh.address, NETWORK);
  const scriptHash = createHash('sha256').update(script).digest('hex');

  TEST_KEYS.push({
    address: p2pkh.address,
    publicKey: keyPair.publicKey,
    script,
    scriptHash,
    scriptHex: script.toString('hex')
  });
}

// ─── Random hash helpers ─────────────────────────────────────────────────────

function randHash() { return crypto.randomBytes(32).toString('hex'); }

// ─── Mock transaction builder ────────────────────────────────────────────────

let txCounter = 0;

function makeTxId() {
  txCounter++;
  return createHash('sha256').update('e2e-tx-' + txCounter + '-' + Date.now()).digest('hex');
}

function resetTxCounter() { txCounter = 0; }

function makeOutput(addressIndex, valueSats) {
  const key = TEST_KEYS[addressIndex];
  return {
    value: BigInt(valueSats),
    script: key.script
  };
}

function makeCoinbaseInput() {
  return {
    hash: Buffer.alloc(32, 0),
    index: 4294967295,
    script: Buffer.alloc(4)
  };
}

function makeSpendInput(prevTxIdHex, prevVout = 0) {
  // bitcoinjs-lib stores input.hash in internal byte order (reversed from display).
  // The tracker does Buffer.from(nextInput.hash).reverse() to get the display txid.
  const hashBuf = Buffer.from(prevTxIdHex, 'hex').reverse();
  return {
    hash: hashBuf,
    index: prevVout,
    script: Buffer.alloc(0)
  };
}

function makeTx(opts = {}) {
  const txid = opts.txid || makeTxId();
  return {
    getId() { return txid; },
    _txid: txid,
    ins: opts.ins || [],
    outs: opts.outs || []
  };
}

function makeCoinbaseTx(addressIndex, valueSats = 50 * SATOSHI) {
  return makeTx({
    ins: [makeCoinbaseInput()],
    outs: [makeOutput(addressIndex, valueSats)]
  });
}

// ─── Block builder ───────────────────────────────────────────────────────────

/**
 * Build a mock block object that matches the shape returned by XChainBlockDecoder.blockFromHex().
 * The critical detail: prevHash must be a Buffer in *internal* byte order (reversed from display hex).
 * The start() loop does: util.uint8ArrayToHex(Buffer.from(block.prevHash).reverse()) to get display hex.
 */
function makeBlock(height, previousHashHex, transactions, hash) {
  const blockHash = hash || randHash();
  // Convert previousHashHex to internal byte order (reversed)
  const prevHashBuf = Buffer.from(previousHashHex, 'hex').reverse();
  return {
    hash: blockHash,
    height,
    previousHash: previousHashHex,
    timestamp: 1700000000 + height * 600,
    // This is the decoded block shape that blockFromHex() returns
    prevHash: prevHashBuf,
    transactions
  };
}

// ─── Chain builder ───────────────────────────────────────────────────────────

/**
 * Build a simple chain of coinbase-only blocks.
 * Returns { blocks, chain } where chain is a height→block map.
 */
function buildCoinbaseChain(count, addressIndex = 0, startHeight = 0, valueSats = 50 * SATOSHI) {
  const blocks = [];
  let prevHash = '0'.repeat(64);

  for (let i = 0; i < count; i++) {
    const height = startHeight + i;
    const tx = makeCoinbaseTx(addressIndex, valueSats);
    const block = makeBlock(height, prevHash, [tx]);
    blocks.push(block);
    prevHash = block.hash;
  }

  return blocks;
}

/**
 * Build a chain with spending transactions.
 * specs is an array of objects:
 *   { coinbase: { to: addressIndex, amount: sats } }
 *   { coinbase: { to: 0, amount: 50*SATOSHI }, spend: { prevTxId, prevVout, outs: [{to, amount}] } }
 */
function buildChainFromSpecs(specs) {
  const blocks = [];
  let prevHash = '0'.repeat(64);

  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const txs = [];

    // Always include a coinbase
    const cbAddr = spec.coinbase ? spec.coinbase.to : 0;
    const cbAmount = spec.coinbase ? spec.coinbase.amount : 50 * SATOSHI;
    txs.push(makeCoinbaseTx(cbAddr, cbAmount));

    // Optional spending transaction
    if (spec.spend) {
      const ins = spec.spend.ins || [makeSpendInput(spec.spend.prevTxId, spec.spend.prevVout || 0)];
      const outs = spec.spend.outs.map(o => makeOutput(o.to, o.amount));
      txs.push(makeTx({ ins, outs }));
    }

    const block = makeBlock(i, prevHash, txs);
    blocks.push(block);
    prevHash = block.hash;
  }

  return blocks;
}

// ─── Blockchain connector stub ───────────────────────────────────────────────

/**
 * Stubs all BlockchainConnector methods on the tracker to serve from a pre-built chain.
 * The chain can be mutated (blocks added/replaced) while the tracker is running.
 *
 * Returns the chain state object so tests can modify it.
 */
function stubBlockchain(tracker, initialBlocks) {
  const state = {
    blocks: [...initialBlocks],
    hashToBlock: new Map(),
    mempool: [],        // array of txids
    mempoolTxHex: {},   // txid → hex (but we stub txFromHex to return the mock tx)
    mempoolTxObjects: {},  // txid → mock tx object
    tipHeight() { return this.blocks.length - 1; }
  };

  // Index blocks by hash
  for (const b of state.blocks) {
    state.hashToBlock.set(b.hash, b);
  }

  // Stub getBlockchainInfo
  sinon.stub(tracker.connector, 'getBlockchainInfo').callsFake(async () => ({
    blocks: state.tipHeight(),
    verificationprogress: 1.0,
    headers: state.tipHeight()
  }));

  // Stub getBlockHash
  sinon.stub(tracker.connector, 'getBlockHash').callsFake(async (height) => {
    if (height >= 0 && height < state.blocks.length) {
      return state.blocks[height].hash;
    }
    throw new Error('Block height out of range: ' + height);
  });

  // Stub getBlock: returns a fake hex string keyed by hash
  sinon.stub(tracker.connector, 'getBlock').callsFake(async (hash) => {
    return 'fakehex_' + hash;
  });

  // Stub getBlocksBatch: used for non-AuxPoW prefetching
  sinon.stub(tracker.connector, 'getBlocksBatch').callsFake(async (heights) => {
    return heights.map(h => {
      const b = state.blocks[h];
      if (!b) throw new Error('Block not found at height ' + h);
      return { height: h, hash: b.hash, hex: 'fakehex_' + b.hash };
    });
  });

  // Stub blockFromHex: maps our fake hex back to the mock block object
  sinon.stub(tracker.xchainBlockDecoder, 'blockFromHex').callsFake((hex) => {
    // hex is 'fakehex_<hash>'
    const hash = hex.replace('fakehex_', '');
    const block = state.hashToBlock.get(hash);
    if (!block) throw new Error('Unknown block hex: ' + hex);
    // Return a fresh object with a fresh prevHash buffer (start() mutates it via .reverse())
    return {
      prevHash: Buffer.from(block.previousHash, 'hex').reverse(),
      timestamp: block.timestamp,
      transactions: block.transactions
    };
  });

  // Stub mempool methods
  sinon.stub(tracker.connector, 'getRawMempool').callsFake(async () => {
    return [...state.mempool];
  });

  sinon.stub(tracker.connector, 'getRawTransactions').callsFake(async (txids) => {
    return txids.map(txid => state.mempoolTxHex[txid] || null);
  });

  sinon.stub(tracker.xchainBlockDecoder, 'txFromHex').callsFake((hex) => {
    // hex is 'fakemptx_<txid>'
    const txid = hex.replace('fakemptx_', '');
    return state.mempoolTxObjects[txid];
  });

  return state;
}

/**
 * Add a block to the chain state (simulates mining a new block).
 */
function addBlockToState(state, block) {
  state.blocks.push(block);
  state.hashToBlock.set(block.hash, block);
}

/**
 * Add a mempool transaction to the chain state.
 */
function addMempoolTx(state, tx) {
  const txid = tx._txid || tx.getId();
  state.mempool.push(txid);
  state.mempoolTxHex[txid] = 'fakemptx_' + txid;
  state.mempoolTxObjects[txid] = tx;
}

/**
 * Remove a mempool transaction from the chain state.
 */
function removeMempoolTx(state, txid) {
  state.mempool = state.mempool.filter(id => id !== txid);
  delete state.mempoolTxHex[txid];
  delete state.mempoolTxObjects[txid];
}

/**
 * Clear all mempool transactions.
 */
function clearMempool(state) {
  state.mempool = [];
  state.mempoolTxHex = {};
  state.mempoolTxObjects = {};
}

// ─── Polling helpers ─────────────────────────────────────────────────────────

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Wait until tracker.db.getLastBlockHeight() reaches the target height.
 */
async function waitForHeight(tracker, height, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const h = await tracker.db.getLastBlockHeight();
      if (h >= height) return h;
    } catch (e) {
      // DB may not be ready yet
    }
    await sleep(100);
  }
  const actual = await tracker.db.getLastBlockHeight().catch(() => -1);
  throw new Error(`Timed out waiting for height ${height} (currently at ${actual})`);
}

/**
 * Wait until tracker.synced becomes true.
 */
async function waitForSynced(tracker, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (tracker.synced) return true;
    await sleep(100);
  }
  throw new Error('Timed out waiting for tracker to sync');
}

// ─── Tracker factory ─────────────────────────────────────────────────────────

/**
 * Create a tracker instance suitable for E2E testing.
 * The tracker is NOT started. Call tracker.start() yourself.
 * The start() method will create its own LevelDB instances.
 *
 * For in-memory DBs, we monkey-patch LevelUpStore so the tracker's start()
 * creates in-memory databases instead of disk ones.
 */
function createE2ETracker() {
  const tracker = new XChainUtxoTracker(
    'bitcoin-regtest', '127.0.0.1', '18443', 'user', 'pass', 'e2e-test-' + Date.now(), false
  );
  return tracker;
}

/**
 * Patch the LevelUpStore module so that ANY new instance uses memory-level
 * (in-memory) regardless of the inMemory constructor param. This lets us test
 * the start() loop (which creates its own DBs) without needing disk access.
 *
 * Returns a restore function.
 */
function patchLevelUpStoreInMemory() {
  const origCreateDatabase = LevelUpStore.prototype.createDatabase;
  const { MemoryLevel } = require('memory-level');

  LevelUpStore.prototype.createDatabase = async function () {
    try {
      this.db = new MemoryLevel({ keyEncoding: 'buffer', valueEncoding: 'buffer' });
      this.inMemory = true;
      await this.db.open();
      return this.db;
    } catch (err) {
      throw new Error("Couldn't open/create LevelDB database");
    }
  };

  return function restore() {
    LevelUpStore.prototype.createDatabase = origCreateDatabase;
  };
}

// ─── Express app factory ─────────────────────────────────────────────────────

function createApiApp(tracker) {
  const app = express();
  app.use(bodyParser.json());

  app.get('/utxos/:address', async (req, res) => {
    try {
      const utxos = await tracker.getUtxosAddress(req.params.address);
      res.json(utxos);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/balance/:address', async (req, res) => {
    try {
      const utxos = await tracker.getUtxosAddress(req.params.address);
      let balance = 0;
      for (const u of utxos) balance += u.amount;
      res.json(balance);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/firstseen/:address', async (req, res) => {
    try {
      const firstSeen = await tracker.getFirstSeen(req.params.address);
      res.json(firstSeen);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/info/:address', async (req, res) => {
    try {
      const info = await tracker.getBalanceInfo(req.params.address);
      res.json(info);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  const jsonRpcController = {
    async ping() { return { status: 'success' }; },
    async get_utxos({ address }) {
      return { utxos: await tracker.getUtxosAddress(address) };
    },
    async get_balance({ address }) {
      const utxos = await tracker.getUtxosAddress(address);
      let balance = 0;
      for (const u of utxos) balance += u.amount;
      return { balance };
    },
    async get_first_seen({ address }) {
      return await tracker.getFirstSeen(address);
    },
    async get_info({ address }) {
      return await tracker.getBalanceInfo(address);
    },
    async get_input_from_key_pattern({ pattern }) {
      if (typeof pattern !== 'string' || pattern.length < 32) {
        return { error: 'pattern is too short' };
      }
      if (!/^[0-9a-fA-F]+$/.test(pattern)) {
        return { error: 'pattern must be a hex string' };
      }
      const results = await tracker.db.getValuesFromKeyPattern(pattern);
      return { result: results };
    }
  };

  app.use(jsonRouter({ methods: jsonRpcController }));

  return { app, request: supertest(app) };
}

module.exports = {
  NETWORK,
  SATOSHI,
  TEST_KEYS,
  randHash,
  makeTxId,
  resetTxCounter,
  makeOutput,
  makeCoinbaseInput,
  makeSpendInput,
  makeTx,
  makeCoinbaseTx,
  makeBlock,
  buildCoinbaseChain,
  buildChainFromSpecs,
  stubBlockchain,
  addBlockToState,
  addMempoolTx,
  removeMempoolTx,
  clearMempool,
  sleep,
  waitForHeight,
  waitForSynced,
  createE2ETracker,
  patchLevelUpStoreInMemory,
  createApiApp
};
