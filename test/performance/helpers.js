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

const { createHash } = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const ECPairFactory = require('ecpair');
const ecc = require('tiny-secp256k1');
const express = require('express');
const bodyParser = require('body-parser');
const jsonRouter = require('express-json-rpc-router');
const http = require('http');
const path = require('path');
const fs = require('fs');

const {
  NETWORK,
  SATOSHI,
  TEST_KEYS,
  randHash,
  resetTxCounter,
  makeOutput,
  makeCoinbaseInput,
  makeSpendInput,
  makeTx,
  makeCoinbaseTx,
  makeBlock,
  processBlock,
  processAndCommit,
  processBlocksAndCommit,
  buildCoinbaseChain,
  createTestTracker,
  closeTracker
} = require('../integration/helpers');

const SCALE_CONFIGS = {
  small:  { blocks: 200,  txsPerBlock: 5,   addresses: 20,  mempoolTxs: 100,  queryConns: 5,  querySecs: 3  },
  medium: { blocks: 500,  txsPerBlock: 20,  addresses: 100, mempoolTxs: 500,  queryConns: 20, querySecs: 10 },
  large:  { blocks: 2000, txsPerBlock: 50,  addresses: 500, mempoolTxs: 2000, queryConns: 50, querySecs: 30 }
};

const SCALE = SCALE_CONFIGS[process.env.PERF_SCALE || 'medium'];

const ECPair = ECPairFactory.ECPairFactory(ecc);

const _addressCache = new Map();

function generateAddressPool(n) {
  if (_addressCache.has(n)) return _addressCache.get(n);

  const pool = [];
  for (let i = 0; i < Math.min(n, 10); i++) {
    pool.push(TEST_KEYS[i]);
  }
  for (let i = 10; i < n; i++) {
    const privKey = createHash('sha256').update('perf-key-' + i).digest();
    const keyPair = ECPair.fromPrivateKey(privKey, { network: NETWORK });
    const p2pkh = bitcoin.payments.p2pkh({ pubkey: keyPair.publicKey, network: NETWORK });
    const script = bitcoin.address.toOutputScript(p2pkh.address, NETWORK);
    const scriptHash = createHash('sha256').update(script).digest('hex');

    pool.push({
      address: p2pkh.address,
      publicKey: keyPair.publicKey,
      script,
      scriptHash,
      scriptHex: script.toString('hex')
    });
  }

  _addressCache.set(n, pool);
  return pool;
}

/**
 * Build a chain of blocks where each block has txsPerBlock coinbase-style
 * transactions spread across the address pool.
 */
function buildDenseChain(count, addressPool, txsPerBlock) {
  const blocks = [];
  let prevHash = '0'.repeat(64);

  for (let i = 0; i < count; i++) {
    const height = i;
    const txs = [];
    for (let t = 0; t < txsPerBlock; t++) {
      const addrIdx = (i * txsPerBlock + t) % addressPool.length;
      const key = addressPool[addrIdx];
      const tx = makeTx({
        ins: [makeCoinbaseInput()],
        outs: [{
          value: BigInt(50 * SATOSHI),
          script: key.script
        }]
      });
      txs.push(tx);
    }
    const block = makeBlock(height, prevHash, txs);
    blocks.push(block);
    prevHash = block.hash;
  }

  return blocks;
}

/**
 * Build a chain that spends UTXOs from a prior chain and creates new outputs.
 * utxoPool: array of { txid, vout, addressIdx } from previously indexed blocks.
 * Returns { blocks, newUtxos } where newUtxos has the same shape for chaining.
 */
function buildSpendingChain(utxoPool, addressPool, blockCount, outsPerTx = 1) {
  const blocks = [];
  const newUtxos = [];
  let prevHash = '0'.repeat(64);
  let utxoIdx = 0;

  for (let i = 0; i < blockCount; i++) {
    const height = i;
    const txs = [makeCoinbaseTx(0)];

    // Spend as many UTXOs as available, up to a reasonable limit per block
    const maxSpends = Math.min(10, utxoPool.length - utxoIdx);
    for (let s = 0; s < maxSpends && utxoIdx < utxoPool.length; s++) {
      const utxo = utxoPool[utxoIdx++];
      const targetIdx = (i + s) % addressPool.length;
      const key = addressPool[targetIdx];

      const tx = makeTx({
        ins: [makeSpendInput(utxo.txid, utxo.vout)],
        outs: [{
          value: BigInt(25 * SATOSHI),
          script: key.script
        }]
      });
      txs.push(tx);
      newUtxos.push({ txid: tx.getId(), vout: 0, addressIdx: targetIdx });
    }

    const block = makeBlock(height, prevHash, txs);
    blocks.push(block);
    prevHash = block.hash;
  }

  return { blocks, newUtxos };
}

/**
 * Extract UTXO references from a dense chain for spending in subsequent chains.
 */
function extractUtxoPool(blocks) {
  const utxos = [];
  for (const block of blocks) {
    for (const tx of block.transactions) {
      const txid = tx.getId();
      for (let vout = 0; vout < tx.outs.length; vout++) {
        utxos.push({ txid, vout });
      }
    }
  }
  return utxos;
}

class MetricsCollector {
  constructor(suiteName) {
    this.suiteName = suiteName;
    this.entries = new Map(); // label -> [durationMs, ...]
    this.meta = new Map();   // label -> {...extras}
  }

  record(label, durationMs, extras = {}) {
    if (!this.entries.has(label)) {
      this.entries.set(label, []);
      this.meta.set(label, extras);
    }
    this.entries.get(label).push(durationMs);
    Object.assign(this.meta.get(label), extras);
  }

  summarize(label) {
    const values = this.entries.get(label);
    if (!values || values.length === 0) return null;

    const sorted = [...values].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);

    return {
      count: sorted.length,
      min: sorted[0],
      avg: sum / sorted.length,
      p50: percentile(sorted, 0.50),
      p95: percentile(sorted, 0.95),
      p99: percentile(sorted, 0.99),
      max: sorted[sorted.length - 1],
      ...this.meta.get(label)
    };
  }

  summarizeAll() {
    const result = {};
    for (const label of this.entries.keys()) {
      result[label] = this.summarize(label);
    }
    return result;
  }

  printTable() {
    console.log(`\n  Performance Results: ${this.suiteName}`);
    console.log('  ' + '─'.repeat(90));
    console.log('  ' + pad('Metric', 30) + pad('Count', 8) + pad('Avg', 12) +
      pad('P50', 12) + pad('P95', 12) + pad('P99', 12) + pad('Max', 12));
    console.log('  ' + '─'.repeat(90));

    for (const label of this.entries.keys()) {
      const s = this.summarize(label);
      console.log('  ' + pad(label, 30) + pad(s.count, 8) +
        pad(formatMs(s.avg), 12) + pad(formatMs(s.p50), 12) +
        pad(formatMs(s.p95), 12) + pad(formatMs(s.p99), 12) +
        pad(formatMs(s.max), 12));
    }
    console.log('  ' + '─'.repeat(90));
  }

  toJSON() {
    return {
      suite: this.suiteName,
      timestamp: new Date().toISOString(),
      scale: process.env.PERF_SCALE || 'medium',
      results: this.summarizeAll()
    };
  }

  saveIfRequested() {
    const dir = process.env.PERF_RESULTS_DIR;
    if (!dir) return;

    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const safeName = this.suiteName.replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
    const filePath = path.join(dir, `${safeName}.json`);
    fs.writeFileSync(filePath, JSON.stringify(this.toJSON(), null, 2));
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = Math.max(0, Math.ceil(sorted.length * p) - 1);
  return sorted[idx];
}

async function measureAsync(fn) {
  const start = process.hrtime.bigint();
  const result = await fn();
  const end = process.hrtime.bigint();
  const durationMs = Number(end - start) / 1e6;
  return { result, durationMs };
}

function formatMs(ms) {
  if (ms < 1) return ms.toFixed(3) + 'ms';
  if (ms < 1000) return ms.toFixed(1) + 'ms';
  return (ms / 1000).toFixed(2) + 's';
}

function formatRate(count, ms) {
  if (ms === 0) return 'Inf';
  const perSec = (count / ms) * 1000;
  if (perSec >= 1000) return (perSec / 1000).toFixed(1) + 'k/s';
  return perSec.toFixed(1) + '/s';
}

function pad(str, len) {
  const s = String(str);
  return s.length >= len ? s : s + ' '.repeat(len - s.length);
}

// HTTP server used as the target for autocannon load tests.
function startHttpServer(tracker) {
  return new Promise((resolve, reject) => {
    const app = express();
    app.use(bodyParser.json());

    app.get('/balance/:address', async (req, res) => {
      try {
        const info = await tracker.getBalanceInfo(req.params.address);
        res.json(info);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    app.get('/utxos/:address', async (req, res) => {
      try {
        const utxos = await tracker.getUtxosAddress(req.params.address);
        res.json(utxos);
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

    app.get('/firstseen/:address', async (req, res) => {
      try {
        const firstSeen = await tracker.getFirstSeen(req.params.address);
        res.json(firstSeen);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });

    const jsonRpcController = {
      async ping() { return { status: 'success' }; },
      async get_balance({ address }) {
        const info = await tracker.getBalanceInfo(address);
        return { balance: info.balances.confirmed };
      },
      async get_utxos({ address }) {
        return { utxos: await tracker.getUtxosAddress(address) };
      },
      async get_info({ address }) {
        return await tracker.getBalanceInfo(address);
      }
    };

    app.use(jsonRouter({ methods: jsonRpcController }));

    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((res) => server.close(res))
      });
    });
    server.on('error', reject);
  });
}

/**
 * Populate the mempool DB with unconfirmed transactions spending from utxoPool.
 * Returns array of { txid, vout } for the new mempool outputs.
 */
async function populateMempool(tracker, utxoPool, addressPool, count) {
  const mempoolUtxos = [];
  await tracker.mempoolDb.beginTransaction();

  for (let i = 0; i < count && i < utxoPool.length; i++) {
    const utxo = utxoPool[i];
    const targetIdx = i % addressPool.length;
    const key = addressPool[targetIdx];

    const tx = makeTx({
      ins: [makeSpendInput(utxo.txid, utxo.vout)],
      outs: [{
        value: BigInt(25 * SATOSHI),
        script: key.script
      }]
    });

    await tracker.parseTxOutputs(tracker.mempoolDb, tx, '0'.repeat(64), -1, false, false);
    await tracker.parseTxInputs(tracker.mempoolDb, tx, '0'.repeat(64), false, false);
    mempoolUtxos.push({ txid: tx.getId(), vout: 0 });
  }

  await tracker.mempoolDb.endTransaction();
  return mempoolUtxos;
}

/**
 * Clear all mempool entries by recreating the in-memory DB.
 */
async function clearMempoolDb(tracker) {
  const LevelUpStore = require('../../src/LevelUpDb');
  const newDb = new LevelUpStore('mempool-perf-' + Date.now() + '-' + Math.random(), true);
  await newDb.createDatabase();
  try { await tracker.mempoolDb.close(); } catch (e) {}
  tracker.mempoolDb = newDb;
}

/**
 * Seed a tracker with a dense chain and return UTXO references.
 * Processes in 100-block batches to match production batch size.
 */
async function seedTracker(tracker, blockCount, addressPool, txsPerBlock) {
  const chain = buildDenseChain(blockCount, addressPool, txsPerBlock);
  const batchSize = 100;

  for (let i = 0; i < chain.length; i += batchSize) {
    const batch = chain.slice(i, i + batchSize);
    await processBlocksAndCommit(tracker, batch);
  }

  const utxoPool = extractUtxoPool(chain);
  return { chain, utxoPool };
}

module.exports = {
  // Scale
  SCALE,
  SCALE_CONFIGS,

  // Re-exports from integration helpers
  NETWORK,
  SATOSHI,
  TEST_KEYS,
  randHash,
  resetTxCounter,
  makeOutput,
  makeCoinbaseInput,
  makeSpendInput,
  makeTx,
  makeCoinbaseTx,
  makeBlock,
  processBlock,
  processAndCommit,
  processBlocksAndCommit,
  buildCoinbaseChain,
  createTestTracker,
  closeTracker,

  // Perf-specific
  generateAddressPool,
  buildDenseChain,
  buildSpendingChain,
  extractUtxoPool,
  seedTracker,
  populateMempool,
  clearMempoolDb,

  // Metrics
  MetricsCollector,
  measureAsync,
  formatMs,
  formatRate,

  // HTTP
  startHttpServer
};
