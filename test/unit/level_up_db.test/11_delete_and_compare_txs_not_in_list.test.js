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
const LevelUpStore = require('../../../src/store/level_up_db');
const crypto = require('crypto');

// Helper: generate a random 32-byte hex string (64 chars)
function randHash() {
  return crypto.randomBytes(32).toString('hex');
}
// Helper: generate a random 8-byte hex string (16 chars)
function randHash8() {
  return crypto.randomBytes(8).toString('hex');
}

let db;

function registerDeleteComparisonTests() {
  describe('deleteAndCompareTxsNotInList', function () {
    it('deletes txs not in the provided list', async function () {
      const tx1 = randHash();
      const tx2 = randHash();
      const scriptHash1 = randHash();
      const scriptHash2 = randHash();
      const tx1_8 = tx1.substring(0, 16);
      const tx2_8 = tx2.substring(0, 16);

      await db.insertTransaction({ hash: tx1, blockHash: randHash() });
      await db.insertTransaction({ hash: tx2, blockHash: randHash() });
      await db.insertOutput({ scriptPubKey: scriptHash1, txHash: tx1_8, outputIndex: 0, value: BigInt(1), height: -1 });
      await db.insertOutputHint({ scriptPubKey: scriptHash1, txHash: tx1_8, outputIndex: 0 });
      await db.insertOutput({ scriptPubKey: scriptHash2, txHash: tx2_8, outputIndex: 0, value: BigInt(2), height: -1 });
      await db.insertOutputHint({ scriptPubKey: scriptHash2, txHash: tx2_8, outputIndex: 0 });
      await db.endTransaction(true);

      // Keep only tx2, delete tx1
      await db.beginTransaction();
      const sortedList = [tx2].sort();
      const result = await db.deleteAndCompareTxsNotInList(sortedList);
      await db.endTransaction(true);

      expect(result.transactionsDeleted).to.equal(1);

      // tx1 outputs should be deleted
      const out1 = await db.getOutputsScriptPubKey(scriptHash1);
      expect(out1).to.be.empty;

      // tx2 outputs should remain
      const out2 = await db.getOutputsScriptPubKey(scriptHash2);
      expect(out2).to.have.length(1);
    });
  });
}

function registerLexSmallerDeletionTests() {
  describe('deleteAndCompareTxsNotInList', function () {
    // Regression for the binary-search polarity bug fixed in commit 095bee7.
    // The prior comparator was inverted AND the not-found check was `== -1`
    // (instead of `< 0`), causing ~40% of not-in-list needles to be
    // misclassified as "found and kept", leaking stale mempool entries
    // through the cleanup path. Pin the txHash bytes so the lex ordering is
    // deterministic instead of relying on random hashes (which gave the
    // original test ~60% pass-by-luck).
    it('deletes the lex-smaller tx when only the lex-larger one is kept (polarity regression)', async function () {
      // tx_lo sorts before tx_hi lexicographically (chosen with '00..' / 'ff..' prefixes)
      const tx_lo = '00' + randHash().substring(2);
      const tx_hi = 'ff' + randHash().substring(2);
      const tx_lo_8 = tx_lo.substring(0, 16);
      const tx_hi_8 = tx_hi.substring(0, 16);
      const scriptHash_lo = randHash();
      const scriptHash_hi = randHash();

      await db.insertTransaction({ hash: tx_lo, blockHash: randHash() });
      await db.insertTransaction({ hash: tx_hi, blockHash: randHash() });
      await db.insertOutput({ scriptPubKey: scriptHash_lo, txHash: tx_lo_8, outputIndex: 0, value: BigInt(1), height: -1 });
      await db.insertOutputHint({ scriptPubKey: scriptHash_lo, txHash: tx_lo_8, outputIndex: 0 });
      await db.insertOutput({ scriptPubKey: scriptHash_hi, txHash: tx_hi_8, outputIndex: 0, value: BigInt(2), height: -1 });
      await db.insertOutputHint({ scriptPubKey: scriptHash_hi, txHash: tx_hi_8, outputIndex: 0 });
      await db.endTransaction(true);

      // Keep only tx_hi → tx_lo should be deleted. Pre-fix this returned
      // bs index -2 for tx_lo (insertion at index 1), the `== -1` check
      // failed, and tx_lo was incorrectly kept.
      await db.beginTransaction();
      const result = await db.deleteAndCompareTxsNotInList([tx_hi].sort());
      await db.endTransaction(true);

      expect(result.transactionsDeleted).to.equal(1);
      expect(await db.getOutputsScriptPubKey(scriptHash_lo)).to.be.empty;
      expect(await db.getOutputsScriptPubKey(scriptHash_hi)).to.have.length(1);
    });
  });
}

function registerLexLargerDeletionTests() {
  describe('deleteAndCompareTxsNotInList', function () {
    // Mirror of the above with the keep-list at lex-low side instead, covering
    // the other branch direction in binary-search.
    it('deletes the lex-larger tx when only the lex-smaller one is kept', async function () {
      const tx_lo = '00' + randHash().substring(2);
      const tx_hi = 'ff' + randHash().substring(2);
      const tx_lo_8 = tx_lo.substring(0, 16);
      const tx_hi_8 = tx_hi.substring(0, 16);
      const scriptHash_lo = randHash();
      const scriptHash_hi = randHash();

      await db.insertTransaction({ hash: tx_lo, blockHash: randHash() });
      await db.insertTransaction({ hash: tx_hi, blockHash: randHash() });
      await db.insertOutput({ scriptPubKey: scriptHash_lo, txHash: tx_lo_8, outputIndex: 0, value: BigInt(1), height: -1 });
      await db.insertOutputHint({ scriptPubKey: scriptHash_lo, txHash: tx_lo_8, outputIndex: 0 });
      await db.insertOutput({ scriptPubKey: scriptHash_hi, txHash: tx_hi_8, outputIndex: 0, value: BigInt(2), height: -1 });
      await db.insertOutputHint({ scriptPubKey: scriptHash_hi, txHash: tx_hi_8, outputIndex: 0 });
      await db.endTransaction(true);

      await db.beginTransaction();
      const result = await db.deleteAndCompareTxsNotInList([tx_lo].sort());
      await db.endTransaction(true);

      expect(result.transactionsDeleted).to.equal(1);
      expect(await db.getOutputsScriptPubKey(scriptHash_hi)).to.be.empty;
      expect(await db.getOutputsScriptPubKey(scriptHash_lo)).to.have.length(1);
    });
  });
}

describe('LevelUpDb', function () {
  beforeEach(async function () {
    db = new LevelUpStore('test-' + Date.now(), true); // in-memory
    await db.createDatabase();
  });

  afterEach(async function () {
    try { await db.close(); } catch (e) { /* already closed */ }
  });

  registerDeleteComparisonTests();
  registerLexSmallerDeletionTests();
  registerLexLargerDeletionTests();
});

  // recoverDeletedOutputsHints() removed 2026-07-10: dead code with zero
  // src/ callers, byte-for-byte identical to the processOutputHints=true
  // half of processDeletedOutputsInDb(). See uuid:340641ec.
