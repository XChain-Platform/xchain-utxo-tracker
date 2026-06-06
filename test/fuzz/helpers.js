'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const fc = require('fast-check');
const crypto = require('crypto');
const { createHash } = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const ECPairFactory = require('ecpair');
const ecc = require('tiny-secp256k1');
const LevelUpStore = require('../../src/LevelUpDb');
const XChainUtxoTracker = require('../../src/XChainUtxoTracker');

const ECPair = ECPairFactory.ECPairFactory(ecc);
const NETWORK = bitcoin.networks.regtest;
const SATOSHI = 100000000;
const FUZZ_RUNS = parseInt(process.env.FUZZ_RUNS, 10) || 1000;

// Max valid satoshi supply for Bitcoin (21M * 10^8)
const MAX_SATOSHI = 2_100_000_000_000_000n;

// ─── Deterministic test addresses (same as integration helpers) ──────────────

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
function randHash8() { return crypto.randomBytes(8).toString('hex'); }

// ─── fast-check arbitraries ────────────────────────────────────────────���────

// Hex string of exactly n bytes (2*n hex chars)
function arbHexString(nBytes) {
  return fc.uint8Array({ minLength: nBytes, maxLength: nBytes })
    .map(arr => Buffer.from(arr).toString('hex'));
}

// 32-byte hex (64 chars) — for txids and block hashes
function arbTxId() { return arbHexString(32); }
function arbBlockHash() { return arbHexString(32); }

// 8-byte hex (16 chars) — for txHash8
function arbTxHash8() { return arbHexString(8); }

// Satoshi value as BigInt in valid range
function arbSatoshiValue() {
  return fc.bigInt({ min: 0n, max: MAX_SATOSHI });
}

// Satoshi value including extreme/boundary values
function arbSatoshiValueExtreme() {
  return fc.oneof(
    fc.constant(0n),
    fc.constant(1n),
    fc.constant(MAX_SATOSHI),
    fc.constant(SATOSHI_BIGINT),                      // exactly 1 BTC
    fc.bigInt({ min: 0n, max: MAX_SATOSHI }),          // normal range
    fc.bigInt({ min: MAX_SATOSHI, max: (1n << 64n) - 1n })  // over supply cap but valid uint64
  );
}

const SATOSHI_BIGINT = 100000000n;

// Block height
function arbHeight() {
  return fc.oneof(
    fc.constant(0),
    fc.constant(-1),    // mempool marker
    fc.integer({ min: 0, max: 4294967295 }),
    fc.constant(4294967295)  // max uint32
  );
}

// Valid confirmed block height (no mempool, no overflow)
function arbConfirmedHeight() {
  return fc.integer({ min: 0, max: 2000000 });
}

// Address arbitrary — mix of valid and invalid
function arbAddress() {
  return fc.oneof(
    // Valid regtest addresses from TEST_KEYS
    fc.integer({ min: 0, max: 9 }).map(i => TEST_KEYS[i].address),
    // Random strings
    fc.string({ minLength: 0, maxLength: 100 }),
    // Near-valid: take a valid address and flip a character
    fc.integer({ min: 0, max: 9 }).chain(i => {
      const addr = TEST_KEYS[i].address;
      return fc.integer({ min: 0, max: addr.length - 1 }).map(pos => {
        return addr.substring(0, pos) + 'X' + addr.substring(pos + 1);
      });
    }),
    // Empty string
    fc.constant(''),
    // Very long string
    fc.string({ minLength: 200, maxLength: 500 })
  );
}

// Valid regtest address only
function arbValidAddress() {
  return fc.integer({ min: 0, max: 9 }).map(i => TEST_KEYS[i].address);
}

// Script buffer of random length
function arbScript() {
  return fc.uint8Array({ minLength: 1, maxLength: 100 }).map(arr => Buffer.from(arr));
}

// Random buffer of exact size
function arbBuffer(size) {
  return fc.uint8Array({ minLength: size, maxLength: size }).map(arr => Buffer.from(arr));
}

// Random buffer of variable size
function arbBufferRange(minLen, maxLen) {
  return fc.uint8Array({ minLength: minLen, maxLength: maxLen }).map(arr => Buffer.from(arr));
}

// Output index (vout)
function arbOutputIndex() {
  return fc.oneof(
    fc.integer({ min: 0, max: 20 }),      // typical
    fc.constant(0),
    fc.constant(4294967295)                 // 0xFFFFFFFF — coinbase marker
  );
}

// Output matching bitcoinjs-lib shape
function arbTxOutput(addressIndex) {
  const idx = addressIndex != null ? addressIndex : 0;
  return arbSatoshiValue().map(value => ({
    value,
    script: TEST_KEYS[idx].script
  }));
}

// Coinbase input shape
function makeCoinbaseInput() {
  return {
    hash: Buffer.alloc(32, 0),
    index: 4294967295
  };
}

// Spending input shape
function makeSpendInput(prevTxIdHex, prevVout = 0) {
  const hashBuf = Buffer.from(prevTxIdHex, 'hex').reverse();
  return {
    hash: hashBuf,
    index: prevVout,
    script: Buffer.alloc(0)
  };
}

// Transaction object matching the shape parseTxOutputs/parseTxInputs expects
function makeTx(opts = {}) {
  const txid = opts.txid || crypto.randomBytes(32).toString('hex');
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
    outs: [{
      value: BigInt(valueSats),
      script: TEST_KEYS[addressIndex].script
    }]
  });
}

// Block object matching what processBlock expects
function makeBlock(height, previousHash, transactions, hash) {
  return {
    hash: hash || randHash(),
    height,
    previousHash,
    timestamp: 1700000000 + height * 600,
    transactions
  };
}

// ─── Tracker lifecycle helpers ───────────────────────────────────────────────

async function createTestTracker() {
  const tracker = new XChainUtxoTracker(
    'bitcoin-regtest', '127.0.0.1', '18443', 'user', 'pass', 'test-db', false
  );

  const db = new LevelUpStore('fuzz-' + Date.now() + '-' + Math.random(), true);
  const mempoolDb = new LevelUpStore('fuzz-mp-' + Date.now() + '-' + Math.random(), true);
  await db.createDatabase();
  await mempoolDb.createDatabase();

  tracker.db = db;
  tracker.mempoolDb = mempoolDb;
  tracker.blockchainInfoLastBlock = 1000;

  return tracker;
}

async function closeTracker(tracker) {
  try { await tracker.db.close(); } catch (e) {}
  try { await tracker.mempoolDb.close(); } catch (e) {}
}

// Process a block through the two-pass pipeline
async function processBlock(tracker, block) {
  const db = tracker.db;

  await db.insertBlock({
    hash: block.hash,
    height: block.height,
    timestamp: block.timestamp,
    previousHash: block.previousHash
  });

  for (const tx of block.transactions) {
    await tracker.parseTxOutputs(db, tx, block.hash, block.height, false, true);
  }
  for (const tx of block.transactions) {
    await tracker.parseTxInputs(db, tx, block.hash, false, true);
  }

  await tracker.addToLastBlocks(block.hash);
  await db.setLastBlockHeight(block.height);
  await db.setLastBlockHash(block.hash);
}

async function processAndCommit(tracker, block) {
  await tracker.db.beginTransaction();
  await processBlock(tracker, block);
  await tracker.db.endTransaction();
  await tracker.cleanupAgedBlocks();
}

async function processBlocksAndCommit(tracker, blocks) {
  await tracker.db.beginTransaction();
  for (const block of blocks) {
    await processBlock(tracker, block);
  }
  await tracker.db.endTransaction();
  await tracker.cleanupAgedBlocks();
}

// Build a chain of coinbase-only blocks
function buildCoinbaseChain(count, addressIndex = 0, startHeight = 0) {
  const blocks = [];
  let prevHash = '0'.repeat(64);

  for (let i = 0; i < count; i++) {
    const height = startHeight + i;
    const tx = makeCoinbaseTx(addressIndex);
    const block = makeBlock(height, prevHash, [tx]);
    blocks.push(block);
    prevHash = block.hash;
  }

  return blocks;
}

module.exports = {
  fc,
  NETWORK,
  SATOSHI,
  FUZZ_RUNS,
  MAX_SATOSHI,
  SATOSHI_BIGINT,
  TEST_KEYS,
  randHash,
  randHash8,
  // Arbitraries
  arbHexString,
  arbTxId,
  arbBlockHash,
  arbTxHash8,
  arbSatoshiValue,
  arbSatoshiValueExtreme,
  arbHeight,
  arbConfirmedHeight,
  arbAddress,
  arbValidAddress,
  arbScript,
  arbBuffer,
  arbBufferRange,
  arbOutputIndex,
  arbTxOutput,
  // Builders
  makeCoinbaseInput,
  makeSpendInput,
  makeTx,
  makeCoinbaseTx,
  makeBlock,
  // Tracker
  createTestTracker,
  closeTracker,
  processBlock,
  processAndCommit,
  processBlocksAndCommit,
  buildCoinbaseChain
};
