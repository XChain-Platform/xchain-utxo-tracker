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

// Coverage for the exact full-txid to block index (T prefix): getTxBlock()'s
// read side and deleteTransactionsInBlock()'s rollback-symmetry write side.

const { expect } = require('chai');
const crypto = require('crypto');
const LevelUpStore = require('../../src/store/level_up_db');

function randHash() { return crypto.randomBytes(32).toString('hex'); }
function randHash8() { return crypto.randomBytes(8).toString('hex'); }

let dbCounter = 0;
function makeDb() {
  return new LevelUpStore('tx-block-index-test-' + Date.now() + '-' + (++dbCounter), true);
}

// Builds a full txid that shares its first 8 bytes (16 hex) with `txid` but
// differs afterward: keys are on the whole txid, so the two must never meet.
function withSamePrefix(txid) {
  return txid.substring(0, 16) + randHash().substring(16);
}

let db;

async function openDatabase() {
  db = makeDb();
  await db.createDatabase();
}

async function closeDatabase() {
  try { await db.close(); } catch (e) { /* already closed */ }
}

async function returnsExactHit() {
  const txHash = randHash();
  const blockHash = randHash();

  await db.insertBlock({ hash: blockHash, height: 42, timestamp: 1700000000, previousHash: randHash() });
  await db.insertTransaction({ hash: txHash, blockHash });
  await db.setLastBlockHeight(42);
  await db.setLastBlockHash(blockHash);
  await db.endTransaction(true);

  const result = await db.getTxBlock(txHash);
  expect(result).to.not.be.null;
  expect(result.block_hash).to.equal(blockHash);
  expect(result.block_height).to.equal(42);
  expect(result.sync).to.deep.equal({ committed_height: 42, committed_hash: blockHash });
}

async function rejectsPrefixCollision() {
  const storedTxid = randHash();
  const blockHash = randHash();
  const collidingTxid = withSamePrefix(storedTxid);
  expect(collidingTxid).to.not.equal(storedTxid);
  expect(collidingTxid.substring(0, 16)).to.equal(storedTxid.substring(0, 16));

  await db.insertBlock({ hash: blockHash, height: 1, timestamp: 1, previousHash: randHash() });
  await db.insertTransaction({ hash: storedTxid, blockHash });
  await db.endTransaction(true);

  expect(await db.getTxBlock(collidingTxid)).to.be.null;
  // The txid actually stored under that prefix is unaffected.
  const hit = await db.getTxBlock(storedTxid);
  expect(hit).to.not.be.null;
  expect(hit.block_hash).to.equal(blockHash);
}

async function deletesBlockTransactionsOnRollback() {
  const txHash = randHash();
  const blockHash = randHash();
  const scriptHash = randHash();

  await db.insertBlock({ hash: blockHash, height: 7, timestamp: 1, previousHash: randHash() });
  await db.insertTransaction({ hash: txHash, blockHash });
  // The W (creation-block reverse index) record deleteTransactionsInBlock
  // reads to find which txids belong to the block; parseBlockTransactions
  // always writes one alongside the T record on the live REMOVE_SPENT path.
  await db.insertOutputBlock({ scriptPubKey: scriptHash, txHash, outputIndex: 0, blockHash });
  await db.endTransaction(true);

  expect(await db.getTxBlock(txHash)).to.not.be.null;

  await db.beginTransaction();
  const deletedCount = await db.deleteTransactionsInBlock(blockHash);
  await db.endTransaction(true);

  expect(deletedCount).to.equal(1);
  expect(await db.getTxBlock(txHash)).to.be.null;
  // getTransactions (the prefix-scan reader) agrees the record is gone too.
  expect(await db.getTransactions(txHash)).to.be.an('array').that.is.empty;
}

async function preservesLiveBlockMapping() {
  const txA = randHash();
  const txB = withSamePrefix(txA);
  expect(txB).to.not.equal(txA);
  const blockA = randHash();
  const blockB = randHash();
  const scriptA = randHash();
  const scriptB = randHash();

  await db.insertBlock({ hash: blockA, height: 10, timestamp: 1, previousHash: randHash() });
  await db.insertTransaction({ hash: txA, blockHash: blockA });
  await db.insertOutputBlock({ scriptPubKey: scriptA, txHash: txA, outputIndex: 0, blockHash: blockA });
  await db.endTransaction(true);

  await db.beginTransaction();
  await db.insertBlock({ hash: blockB, height: 11, timestamp: 2, previousHash: blockA });
  // Same first 8 bytes as txA: this insert must not touch any of txA's records,
  // since every T, X and Y key carries the whole txid.
  await db.insertTransaction({ hash: txB, blockHash: blockB });
  await db.insertOutputBlock({ scriptPubKey: scriptB, txHash: txB, outputIndex: 0, blockHash: blockB });
  await db.endTransaction(true);

  const hitA = await db.getTxBlock(txA);
  expect(hitA).to.not.be.null;
  expect(hitA.block_hash).to.equal(blockA);
  const hitB = await db.getTxBlock(txB);
  expect(hitB).to.not.be.null;
  expect(hitB.block_hash).to.equal(blockB);

  // Roll back only blockB, as a real reorg walk would: it never rolls back
  // blockA without first rolling back blockB.
  await db.beginTransaction();
  const deletedCount = await db.deleteTransactionsInBlock(blockB);
  await db.endTransaction(true);

  expect(deletedCount).to.equal(1);
  expect(await db.getTxBlock(txB)).to.be.null;
  // txA's mapping survives without the rollback deleting its exact index.
  const hitAAfter = await db.getTxBlock(txA);
  expect(hitAAfter).to.not.be.null;
  expect(hitAAfter.block_hash).to.equal(blockA);
}

async function rejectsUnknownTxid() {
  expect(await db.getTxBlock(randHash())).to.be.null;
}

async function rejectsMalformedTxid() {
  expect(await db.getTxBlock(randHash8())).to.be.null;
  expect(await db.getTxBlock('not-hex-'.repeat(8))).to.be.null;
  expect(await db.getTxBlock(null)).to.be.null;
}

async function rejectsLegacyRecord() {
  const txHash = randHash();
  const blockHash = randHash();

  await db.insertBlock({ hash: blockHash, height: 3, timestamp: 1, previousHash: randHash() });
  // A T record with the 32-byte (block hash only) value and no X record, the
  // shape a bulk-sync seed writes with its tx index off: getTxBlock reads X only.
  await db.addTransaction('put', LevelUpStore.kTx(txHash), LevelUpStore.encodeTx(blockHash));
  await db.endTransaction(true);

  expect(await db.getTxBlock(txHash)).to.be.null;
}

// Pin the no-Y rollback rule a bulk-sync seed relies on (bulk_sync/SPEC.md,
// "T value shape"): a 32-byte T with no Y record is still cleared on rollback.
async function deletesLegacyTRecordWithoutRecoveryOnRollback() {
  const txHash = randHash();
  const blockHash = randHash();

  await db.insertBlock({ hash: blockHash, height: 5, timestamp: 1, previousHash: randHash() });
  // Write only the T and W records a seed carries, never insertTransaction, so no X/Y exists.
  await db.addTransaction('put', LevelUpStore.kTx(txHash), LevelUpStore.encodeTx(blockHash));
  await db.insertOutputBlock({ scriptPubKey: randHash(), txHash, outputIndex: 0, blockHash });
  await db.endTransaction(true);

  expect(await db.getTransactions(txHash)).to.have.lengthOf(1);

  await db.beginTransaction();
  const deletedCount = await db.deleteTransactionsInBlock(blockHash);
  await db.endTransaction(true);

  expect(deletedCount).to.equal(1);
  expect(await db.getTransactions(txHash)).to.be.an('array').that.is.empty;
}

async function reportsCommittedTip() {
  const txHash = randHash();
  const blockHash = randHash();
  const staleHash = randHash();

  await db.insertBlock({ hash: blockHash, height: 100, timestamp: 1, previousHash: randHash() });
  await db.insertTransaction({ hash: txHash, blockHash });
  // The committed tip pointer lags behind the block this tx is actually in,
  // e.g. because the tip metadata write for this flush has not landed yet.
  await db.setLastBlockHeight(10);
  await db.setLastBlockHash(staleHash);
  await db.endTransaction(true);

  const result = await db.getTxBlock(txHash);
  expect(result).to.not.be.null;
  expect(result.block_hash).to.equal(blockHash);
  expect(result.block_height).to.equal(100);
  expect(result.sync).to.deep.equal({ committed_height: 10, committed_hash: staleHash });
}

async function rejectsMissingBlockRecord() {
  const txHash = randHash();
  const blockHash = randHash();

  // insertTransaction without a matching insertBlock: the T record points
  // at a block that either never existed or was already deleted.
  await db.insertTransaction({ hash: txHash, blockHash });
  await db.endTransaction(true);

  expect(await db.getTxBlock(txHash)).to.be.null;
}

function registerTxBlockIndexTests() {
  it('returns block_hash, block_height and sync on an exact hit', returnsExactHit);
  it('returns null for a different txid sharing the stored 8-byte prefix', rejectsPrefixCollision);
  it('deletes the T record for every tx in a block on rollback', deletesBlockTransactionsOnRollback);
  it('keeps a live block\'s mapping when a different, later block whose tx shares the same 8-byte prefix is rolled back', preservesLiveBlockMapping);
  it('returns null for a txid that was never indexed', rejectsUnknownTxid);
  it('returns null for a malformed txid instead of throwing', rejectsMalformedTxid);
  it('returns null for a legacy pre-migration record with no stored full txid', rejectsLegacyRecord);
  it('deletes a 32-byte T record that has no Y recovery record on rollback', deletesLegacyTRecordWithoutRecoveryOnRollback);
  it('reports the store\'s own committed tip even when it is stale relative to the found tx', reportsCommittedTip);
  it('returns null when the tx\'s own block record no longer exists', rejectsMissingBlockRecord);
}

describe('LevelUpDb tx block index (T prefix)', function () {
  beforeEach(openDatabase);
  afterEach(closeDatabase);
  registerTxBlockIndexTests();
});
