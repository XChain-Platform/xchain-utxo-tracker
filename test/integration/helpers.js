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
const bitcoin = require('bitcoinjs-lib');
const ECPairFactory = require('ecpair');
const ecc = require('tiny-secp256k1');
const LevelUpStore = require('../../src/LevelUpDb');
const XChainUtxoTracker = require('../../src/XChainUtxoTracker');

const ECPair = ECPairFactory.ECPairFactory(ecc);
const NETWORK = bitcoin.networks.regtest;
const SATOSHI = 100000000;

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

// The tracker reports every UTXO `amount` and every balance as a fixed-8 DECIMAL
// STRING, not a Number: plain `value / 1e8` loses precision once a total passes
// Number.MAX_SAFE_INTEGER (DOGE balances above ~90M), so the whole formatting path
// is BigInt. Tests that compared `amount` against a JS number were written before
// that change and silently stopped asserting anything real. Compare against
// coinAmount(...) instead, and sum with sumAmounts(...) rather than `+` (which
// concatenates strings).

// '50' / 50 / '39.99' -> '50.00000000' / '39.99000000'. Exact: no float math.
function coinAmount(coins) {
  const s = String(coins);
  const neg = s.startsWith('-');
  const [whole, frac = ''] = (neg ? s.slice(1) : s).split('.');
  return (neg ? '-' : '') + (whole || '0') + '.' + (frac + '00000000').slice(0, 8);
}

// Decimal string -> BigInt satoshis.
function amountToSatoshi(amount) {
  const s = String(amount);
  const neg = s.startsWith('-');
  const [whole, frac = ''] = (neg ? s.slice(1) : s).split('.');
  const sats = BigInt(whole || '0') * BigInt(100000000) + BigInt((frac + '00000000').slice(0, 8));
  return neg ? -sats : sats;
}

// Total of a UTXO list's amounts, returned in the same decimal-string form.
function sumAmounts(utxos) {
  let total = BigInt(0);
  for (const u of utxos) total += amountToSatoshi(u.amount);
  const neg = total < BigInt(0);
  const abs = neg ? -total : total;
  return (neg ? '-' : '') + (abs / BigInt(100000000)).toString() + '.' +
    (abs % BigInt(100000000)).toString().padStart(8, '0');
}

function randHash() { return crypto.randomBytes(32).toString('hex'); }
function randHash8() { return crypto.randomBytes(8).toString('hex'); }

let txCounter = 0;

function makeTxId() {
  // Deterministic but unique txids within a test run
  txCounter++;
  return createHash('sha256').update('tx-' + txCounter + '-' + Date.now()).digest('hex');
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
    index: 4294967295, // 0xFFFFFFFF
    script: Buffer.alloc(4)
  };
}

function makeSpendInput(prevTxIdHex, prevVout = 0) {
  // bitcoinjs-lib stores input.hash in internal byte order (reversed from display).
  // The tracker does Buffer.from(nextInput.hash).reverse() to get the display txid.
  // We store reversed (wire order) so that reversal yields the original hex.
  const hashBuf = Buffer.from(prevTxIdHex, 'hex').reverse();
  return {
    hash: hashBuf,
    index: prevVout,
    script: Buffer.alloc(0)
  };
}

// Shape mirrors bitcoinjs-lib's Transaction interface (getId(), ins, outs).
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

function makeBlock(height, previousHash, transactions, hash) {
  return {
    hash: hash || randHash(),
    height,
    previousHash,
    timestamp: 1700000000 + height * 600,
    transactions
  };
}

async function processBlock(tracker, block) {
  const db = tracker.db;

  await db.insertBlock({
    hash: block.hash,
    height: block.height,
    timestamp: block.timestamp,
    previousHash: block.previousHash
  });

  // Two passes: outputs must be written before inputs are parsed, so a
  // same-block spend can find the output it's spending.
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

async function createTestTracker() {
  const tracker = new XChainUtxoTracker(
    'bitcoin-regtest', '127.0.0.1', '18443', 'user', 'pass', 'test-db', false
  );

  // LevelUpStore.knownScripts is a PROCESS-GLOBAL (static) existence cache, not a
  // per-store one: insertOutputScriptBlock returns early on a hit and writes no S
  // record. Every test here builds a brand-new empty store, so without this reset
  // the second and later tests inherit the first test's script set, skip the S
  // write, and every getFirstSeen / getOutputScriptBlock assertion reads null.
  LevelUpStore.knownScripts = new Set();

  const db = new LevelUpStore('tracker-int-' + Date.now() + '-' + Math.random(), true);
  const mempoolDb = new LevelUpStore('mempool-int-' + Date.now() + '-' + Math.random(), true);
  await db.createDatabase();
  await mempoolDb.createDatabase();

  tracker.db = db;
  tracker.mempoolDb = mempoolDb;
  tracker.blockchainInfoLastBlock = 1000;
  // These harnesses mine short synthetic chains and treat coinbase outputs as
  // ordinary spendable coins; coinbase-maturity policy is exercised in its
  // own regression test, so disable the maturity gate here to keep the many
  // low-height / low-tip indexing assertions valid.
  tracker.coinbaseMaturity = 0;

  return tracker;
}

async function closeTracker(tracker) {
  try { await tracker.db.close(); } catch (e) {}
  try { await tracker.mempoolDb.close(); } catch (e) {}
}

module.exports = {
  NETWORK,
  SATOSHI,
  TEST_KEYS,
  coinAmount,
  amountToSatoshi,
  sumAmounts,
  randHash,
  randHash8,
  makeTxId,
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
};
