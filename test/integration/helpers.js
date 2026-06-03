'use strict';

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

// ─── Deterministic test addresses ────────────────────────────────────────────

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

// ─── Mock transaction builder (mirrors bitcoinjs-lib Transaction shape) ──────

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

function makeBlock(height, previousHash, transactions, hash) {
  return {
    hash: hash || randHash(),
    height,
    previousHash,
    timestamp: 1700000000 + height * 600,
    transactions
  };
}

// ─── Process a block through the tracker (two-pass) ──────────────────────────

async function processBlock(tracker, block) {
  const db = tracker.db;

  await db.insertBlock({
    hash: block.hash,
    height: block.height,
    timestamp: block.timestamp,
    previousHash: block.previousHash
  });

  // Pass 1: all outputs
  for (const tx of block.transactions) {
    await tracker.parseTxOutputs(db, tx, block.hash, block.height, false, true);
  }

  // Pass 2: all inputs
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

// ─── Build a chain of coinbase-only blocks ───────────────────────────────────

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

// ─── Create a fresh tracker with in-memory DBs ──────────────────────────────

async function createTestTracker() {
  const tracker = new XChainUtxoTracker(
    'bitcoin-regtest', '127.0.0.1', '18443', 'user', 'pass', 'test-db', false
  );

  const db = new LevelUpStore('tracker-int-' + Date.now() + '-' + Math.random(), true);
  const mempoolDb = new LevelUpStore('mempool-int-' + Date.now() + '-' + Math.random(), true);
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

module.exports = {
  NETWORK,
  SATOSHI,
  TEST_KEYS,
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
