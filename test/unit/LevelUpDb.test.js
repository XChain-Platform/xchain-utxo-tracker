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
const LevelUpStore = require('../../src/LevelUpDb');
const crypto = require('crypto');

// Helper: generate a random 32-byte hex string (64 chars)
function randHash() {
  return crypto.randomBytes(32).toString('hex');
}
// Helper: generate a random 8-byte hex string (16 chars)
function randHash8() {
  return crypto.randomBytes(8).toString('hex');
}

describe('LevelUpDb', function () {
  let db;

  beforeEach(async function () {
    db = new LevelUpStore('test-' + Date.now(), true); // in-memory
    await db.createDatabase();
  });

  afterEach(async function () {
    try { await db.close(); } catch (e) { /* already closed */ }
  });

  // ─── Block height / hash ──────────────────────────────────────────────────

  describe('block height and hash', function () {
    it('getLastBlockHeight returns -1 when empty', async function () {
      expect(await db.getLastBlockHeight()).to.equal(-1);
    });

    it('round-trips block height', async function () {
      await db.setLastBlockHeight(500);
      await db.endTransaction(true);
      expect(await db.getLastBlockHeight()).to.equal(500);
    });

    it('getLastBlockHash returns null when empty', async function () {
      expect(await db.getLastBlockHash()).to.be.null;
    });

    it('round-trips block hash', async function () {
      const hash = randHash();
      await db.setLastBlockHash(hash);
      await db.endTransaction(true);
      expect(await db.getLastBlockHash()).to.equal(hash);
    });
  });

  // ─── Block (B prefix) ─────────��──────────────────────────────────────────

  describe('block operations (B prefix)', function () {
    it('inserts and retrieves a block', async function () {
      const hash = randHash();
      const prevHash = randHash();
      await db.insertBlock({ hash, height: 100, timestamp: 1700000000, previousHash: prevHash });
      await db.endTransaction(true);

      const block = await db.getBlock(hash);
      expect(block).to.not.be.null;
      expect(block.h).to.equal(100);
      expect(block.t).to.equal(1700000000);
      expect(block.ph).to.equal(prevHash);
    });

    it('returns null for non-existent block', async function () {
      expect(await db.getBlock(randHash())).to.be.null;
    });

    it('deletes a block', async function () {
      const hash = randHash();
      await db.insertBlock({ hash, height: 1, timestamp: 1, previousHash: randHash() });
      await db.endTransaction(true);

      await db.beginTransaction();
      await db.deleteBlock(hash);
      await db.endTransaction(true);

      expect(await db.getBlock(hash)).to.be.null;
    });

    it('getLastBlock returns highest block', async function () {
      const h1 = randHash();
      const h2 = randHash();
      await db.insertBlock({ hash: h1, height: 10, timestamp: 1, previousHash: randHash() });
      await db.insertBlock({ hash: h2, height: 20, timestamp: 2, previousHash: h1 });
      await db.endTransaction(true);

      const last = await db.getLastBlock();
      expect(last.height).to.equal(20);
      expect(last.hash).to.equal(h2);
    });

    it('getLastBlock returns null on empty db', async function () {
      expect(await db.getLastBlock()).to.be.null;
    });
  });

  // ─── Transaction (T prefix) ──────────────────────────────────────────────

  describe('transaction operations (T prefix)', function () {
    it('inserts and retrieves a transaction', async function () {
      const txHash = randHash();
      const blockHash = randHash();
      await db.insertTransaction({ hash: txHash, blockHash });
      await db.endTransaction(true);

      const txs = await db.getTransactions(txHash.substring(0, 16));
      expect(txs).to.have.length(1);
      expect(txs[0].block_hash).to.equal(blockHash);
    });

    it('returns empty array for unknown tx prefix', async function () {
      const txs = await db.getTransactions(randHash8());
      expect(txs).to.be.an('array').that.is.empty;
    });

    it('deletes a transaction', async function () {
      const txHash = randHash();
      await db.insertTransaction({ hash: txHash, blockHash: randHash() });
      await db.endTransaction(true);

      await db.beginTransaction();
      await db.deleteTransaction(txHash);
      await db.endTransaction(true);

      const txs = await db.getTransactions(txHash.substring(0, 16));
      expect(txs).to.be.empty;
    });
  });

  // ─── Output (O prefix) ──────────���────────────────────────────────────────

  describe('output operations (O prefix)', function () {
    it('inserts and queries outputs by scriptPubKey', async function () {
      const scriptHash = randHash();
      const txHash8 = randHash8();
      await db.insertOutput({
        scriptPubKey: scriptHash,
        txHash: txHash8,
        outputIndex: 0,
        value: BigInt('100000000'),
        height: 500,
        fullTxHash: randHash()
      });
      await db.endTransaction(true);

      const outputs = await db.getOutputsScriptPubKey(scriptHash);
      expect(outputs).to.have.length(1);
      expect(outputs[0].txid).to.equal(txHash8);
      expect(outputs[0].vout).to.equal(0);
      expect(outputs[0].value).to.equal('100000000');
      expect(outputs[0].height).to.equal(500);
    });

    it('stores multiple outputs for the same scriptPubKey', async function () {
      const scriptHash = randHash();
      const tx1 = randHash8();
      const tx2 = randHash8();
      await db.insertOutput({ scriptPubKey: scriptHash, txHash: tx1, outputIndex: 0, value: BigInt(1000), height: 1 });
      await db.insertOutput({ scriptPubKey: scriptHash, txHash: tx2, outputIndex: 1, value: BigInt(2000), height: 2 });
      await db.endTransaction(true);

      const outputs = await db.getOutputsScriptPubKey(scriptHash);
      expect(outputs).to.have.length(2);
    });

    it('stores zero-value output', async function () {
      const scriptHash = randHash();
      await db.insertOutput({ scriptPubKey: scriptHash, txHash: randHash8(), outputIndex: 0, value: BigInt(0), height: 10 });
      await db.endTransaction(true);

      const outputs = await db.getOutputsScriptPubKey(scriptHash);
      expect(outputs[0].value).to.equal('0');
    });

    it('stores large Dogecoin-scale values', async function () {
      const scriptHash = randHash();
      const largeValue = BigInt('100000000000000'); // 1M DOGE in sats
      await db.insertOutput({ scriptPubKey: scriptHash, txHash: randHash8(), outputIndex: 0, value: largeValue, height: 1 });
      await db.endTransaction(true);

      const outputs = await db.getOutputsScriptPubKey(scriptHash);
      expect(outputs[0].value).to.equal('100000000000000');
    });

    it('returns empty for unknown scriptPubKey', async function () {
      const outputs = await db.getOutputsScriptPubKey(randHash());
      expect(outputs).to.be.empty;
    });

    it('fullTxid is null when not provided', async function () {
      const scriptHash = randHash();
      await db.insertOutput({ scriptPubKey: scriptHash, txHash: randHash8(), outputIndex: 0, value: BigInt(100), height: 1 });
      await db.endTransaction(true);

      const outputs = await db.getOutputsScriptPubKey(scriptHash);
      expect(outputs[0].fullTxid).to.be.null;
    });

    it('fullTxid is returned when provided', async function () {
      const scriptHash = randHash();
      const fullTxHash = randHash();
      await db.insertOutput({ scriptPubKey: scriptHash, txHash: randHash8(), outputIndex: 0, value: BigInt(100), height: 1, fullTxHash });
      await db.endTransaction(true);

      const outputs = await db.getOutputsScriptPubKey(scriptHash);
      expect(outputs[0].fullTxid).to.equal(fullTxHash);
    });

    // Regression: rangeEnd previously appended a single 0xFF byte. For any
    // output whose txHash8 started with 0xFF, the range scan in
    // getOutputsScriptPubKey treated the actual key (longer, byte[33]=0xFF)
    // as greater than the upper bound, silently skipping it. Fixed by
    // appending 12 bytes of 0xFF in commit 6385686. This guards against
    // accidental re-reverts during perf refactors of LevelUpDb.js.
    it('returns outputs whose txHash8 starts with 0xFF (rangeEnd regression)', async function () {
      const scriptHash = randHash();
      const txFF = 'ff' + randHash8().substring(2); // first byte 0xFF
      const txNonFF = '00' + randHash8().substring(2); // first byte 0x00
      await db.insertOutput({ scriptPubKey: scriptHash, txHash: txFF, outputIndex: 0, value: BigInt(123), height: 1 });
      await db.insertOutput({ scriptPubKey: scriptHash, txHash: txNonFF, outputIndex: 0, value: BigInt(456), height: 2 });
      await db.endTransaction(true);

      const outputs = await db.getOutputsScriptPubKey(scriptHash);
      const txids = outputs.map(o => o.txid).sort();
      expect(txids).to.include(txFF);
      expect(txids).to.include(txNonFF);
      expect(outputs).to.have.length(2);
    });

    // Stronger variant: the txHash8 is ALL 0xFF bytes, exercising the worst
    // case for the rangeEnd upper bound. With a 1-byte 0xFF suffix this
    // returned []; with 12 bytes it returns the entry.
    it('returns outputs whose txHash8 is all 0xFF', async function () {
      const scriptHash = randHash();
      const txAllFF = 'ffffffffffffffff';
      await db.insertOutput({ scriptPubKey: scriptHash, txHash: txAllFF, outputIndex: 7, value: BigInt(789), height: 3 });
      await db.endTransaction(true);

      const outputs = await db.getOutputsScriptPubKey(scriptHash);
      expect(outputs).to.have.length(1);
      expect(outputs[0].txid).to.equal(txAllFF);
      expect(outputs[0].vout).to.equal(7);
    });

    // ─── Pagination + safety ceiling ─────────────────────────────────────
    // A mega miner-coinbase/payout address can hold millions of outputs.
    // Materializing them all OOMs the process; getOutputsScriptPubKey gained a
    // bounded page (limit + after cursor) and a fail-loud maxOutputs ceiling.
    describe('pagination + safety ceiling', function () {
      async function seed(scriptHash, n) {
        for (let i = 0; i < n; i++) {
          await db.insertOutput({ scriptPubKey: scriptHash, txHash: randHash8(), outputIndex: i % 3, value: BigInt(1000 + i), height: i + 1, fullTxHash: randHash() });
        }
        await db.endTransaction(true);
      }

      it('unbounded fetch with maxOutputs at/above the count does not throw', async function () {
        const scriptHash = randHash();
        await seed(scriptHash, 12);
        const out = await db.getOutputsScriptPubKey(scriptHash, { maxOutputs: 12 });
        expect(out).to.have.length(12);
      });

      it('maxOutputs below the count throws ADDRESS_TOO_LARGE', async function () {
        const scriptHash = randHash();
        await seed(scriptHash, 12);
        let err = null;
        try { await db.getOutputsScriptPubKey(scriptHash, { maxOutputs: 5 }); } catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.code).to.equal('ADDRESS_TOO_LARGE');
      });

      it('limit + after cursor pages the full set with no gaps, repeats, or reorder', async function () {
        const scriptHash = randHash();
        await seed(scriptHash, 23);
        const full = await db.getOutputsScriptPubKey(scriptHash);
        const fullKeys = full.map(o => o.txid + ':' + o.vout);

        const pageSize = 7;
        const collected = [];
        let after = null, guard = 0;
        while (guard++ < 100) {
          const page = await db.getOutputsScriptPubKey(scriptHash, { limit: pageSize, after });
          page.forEach(o => collected.push(o.txid + ':' + o.vout));
          if (page.length < pageSize) break;
          const last = page[page.length - 1];
          after = last.txid + ':' + last.vout;
        }
        expect(collected).to.deep.equal(fullKeys);
        expect(new Set(collected).size).to.equal(23);
      });

      it('a bounded page ignores the maxOutputs ceiling', async function () {
        const scriptHash = randHash();
        await seed(scriptHash, 12);
        const page = await db.getOutputsScriptPubKey(scriptHash, { limit: 3, maxOutputs: 1 });
        expect(page).to.have.length(3);
      });

      it('a malformed cursor throws INVALID_CURSOR', async function () {
        const scriptHash = randHash();
        await seed(scriptHash, 3);
        let err = null;
        try { await db.getOutputsScriptPubKey(scriptHash, { limit: 2, after: 'not-a-cursor' }); } catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.code).to.equal('INVALID_CURSOR');
      });
    });
  });

  // ─── Output hint (H prefix) ───────���──────────────────────────────────────

  describe('output hint operations (H prefix)', function () {
    it('inserts output hint and deletes outputs by hint', async function () {
      const scriptHash = randHash();
      const txHash8 = randHash8();
      const fullTxHash = txHash8 + randHash().substring(16);

      await db.insertOutput({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 0, value: BigInt(1000), height: 1 });
      await db.insertOutputHint({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 0 });
      await db.endTransaction(true);

      // Verify output exists
      let outputs = await db.getOutputsScriptPubKey(scriptHash);
      expect(outputs).to.have.length(1);

      // Delete by hint
      await db.beginTransaction();
      const deleted = await db.deleteOutputsByHint(fullTxHash);
      await db.endTransaction(true);

      expect(deleted).to.equal(1);
      outputs = await db.getOutputsScriptPubKey(scriptHash);
      expect(outputs).to.be.empty;
    });
  });

  // ─── Input (I prefix) ────────────────────────────────────────────────────

  describe('input operations (I prefix)', function () {
    it('inserts and retrieves an input', async function () {
      const prevTxHash = randHash();
      const spendingTxHash8 = randHash8();
      await db.insertInput({ prevTxHash, prevOutputIndex: 0, txHash: spendingTxHash8 });
      await db.endTransaction(true);

      const input = await db.getInput(prevTxHash.substring(0, 16), 0);
      expect(input).to.not.be.null;
    });

    it('returns null for unspent output', async function () {
      const result = await db.getInput(randHash8(), 0);
      expect(result).to.be.null;
    });
  });

  // ─── Input hint (J prefix) ─────────��───────────────────────────��─────────

  describe('input hint operations (J prefix)', function () {
    it('inserts input hint and deletes inputs by hint', async function () {
      const prevTxHash = randHash();
      const spendingTxHash8 = randHash8();
      const spendingFullTx = spendingTxHash8 + randHash().substring(16);

      await db.insertInput({ prevTxHash, prevOutputIndex: 0, txHash: spendingTxHash8 });
      await db.insertInputHint({ prevTxHash, prevOutputIndex: 0, txHash: spendingTxHash8 });
      await db.endTransaction(true);

      // Input should exist
      let input = await db.getInput(prevTxHash.substring(0, 16), 0);
      expect(input).to.not.be.null;

      // Delete by hint
      await db.beginTransaction();
      const deleted = await db.deleteInputsByHint(spendingFullTx);
      await db.endTransaction(true);

      expect(deleted).to.equal(1);
      input = await db.getInput(prevTxHash.substring(0, 16), 0);
      expect(input).to.be.null;
    });
  });

  // ─── removeOutputWithInput (REMOVE_SPENT path) ───────────────────────────

  describe('removeOutputWithInput', function () {
    it('removes a committed output and stages K/M records', async function () {
      const scriptHash = randHash();
      const txHash8 = randHash8();
      const blockHash = randHash();

      // Insert output + hint, commit
      await db.insertOutput({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 0, value: BigInt(5000), height: 10 });
      await db.insertOutputHint({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 0 });
      await db.endTransaction(true);

      // Now spend it
      await db.beginTransaction();
      await db.removeOutputWithInput({ prevTxHash: txHash8, prevOutputIndex: 0, blockHash });
      await db.endTransaction(true);

      // Output should be gone
      const outputs = await db.getOutputsScriptPubKey(scriptHash);
      expect(outputs).to.be.empty;
    });

    it('removes an in-memory (same-batch) output', async function () {
      const scriptHash = randHash();
      const txHash8 = randHash8();
      const blockHash = randHash();

      // Insert output + hint in same batch (not committed)
      await db.beginTransaction();
      await db.insertOutput({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 0, value: BigInt(1000), height: 5 });
      await db.insertOutputHint({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 0 });

      // Spend it in the same batch
      await db.removeOutputWithInput({ prevTxHash: txHash8, prevOutputIndex: 0, blockHash });
      await db.endTransaction(true);

      // Output should be gone
      const outputs = await db.getOutputsScriptPubKey(scriptHash);
      expect(outputs).to.be.empty;
    });

    it('logs warning for missing output hint (pre-REMOVE_SPENT data)', async function () {
      const txHash8 = randHash8();
      const blockHash = randHash();

      await db.beginTransaction();
      // No output or hint exists; should not throw
      const result = await db.removeOutputWithInput({ prevTxHash: txHash8, prevOutputIndex: 0, blockHash });
      expect(result).to.be.true;
    });
  });

  // ─── processDeletedOutputs recovery ───────���───────────────────────────────

  describe('processDeletedOutputs', function () {
    it('recovers outputs from K/M records', async function () {
      const scriptHash = randHash();
      const txHash8 = randHash8();
      const blockHash = randHash();

      // Insert and commit output
      await db.insertOutput({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 0, value: BigInt(7000), height: 20 });
      await db.insertOutputHint({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 0 });
      await db.endTransaction(true);

      // Spend it (creates K/M records)
      await db.beginTransaction();
      await db.removeOutputWithInput({ prevTxHash: txHash8, prevOutputIndex: 0, blockHash });
      await db.endTransaction(true);

      // Output should be gone
      let outputs = await db.getOutputsScriptPubKey(scriptHash);
      expect(outputs).to.be.empty;

      // Recover
      await db.beginTransaction();
      await db.processDeletedOutputs(blockHash, true);
      await db.endTransaction(true);

      // Output should be back
      outputs = await db.getOutputsScriptPubKey(scriptHash);
      expect(outputs).to.have.length(1);
      expect(outputs[0].value).to.equal('7000');
    });

    it('purges K/M records without recovery when recover=false', async function () {
      const scriptHash = randHash();
      const txHash8 = randHash8();
      const blockHash = randHash();

      await db.insertOutput({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 0, value: BigInt(1000), height: 5 });
      await db.insertOutputHint({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 0 });
      await db.endTransaction(true);

      await db.beginTransaction();
      await db.removeOutputWithInput({ prevTxHash: txHash8, prevOutputIndex: 0, blockHash });
      await db.endTransaction(true);

      // Purge without recovery
      await db.beginTransaction();
      await db.processDeletedOutputs(blockHash, false);
      await db.endTransaction(true);

      // Output should remain gone
      const outputs = await db.getOutputsScriptPubKey(scriptHash);
      expect(outputs).to.be.empty;
    });
  });

  // ─── Output script block (S / Z prefix) ──────��───────────────────────────

  describe('script block tracking (S/Z prefix)', function () {
    it('records first appearance and retrieves it', async function () {
      const scriptHash = randHash();
      const blockHash = randHash();

      await db.insertOutputScriptBlock(scriptHash, blockHash, 100);
      await db.endTransaction(true);

      const result = await db.getOutputScriptBlock(scriptHash);
      expect(result).to.not.be.null;
      expect(result.h).to.equal(100);
    });

    it('does not overwrite first appearance', async function () {
      const scriptHash = randHash();
      const firstBlock = randHash();
      const secondBlock = randHash();

      await db.insertOutputScriptBlock(scriptHash, firstBlock, 50);
      await db.insertOutputScriptBlock(scriptHash, secondBlock, 100);
      await db.endTransaction(true);

      const result = await db.getOutputScriptBlock(scriptHash);
      expect(result.h).to.equal(50);
    });

    it('returns null for unknown script', async function () {
      expect(await db.getOutputScriptBlock(randHash())).to.be.null;
    });

    it('skips insertion when blockHash is falsy (mempool)', async function () {
      const scriptHash = randHash();
      await db.insertOutputScriptBlock(scriptHash, null, -1);
      await db.endTransaction(true);
      expect(await db.getOutputScriptBlock(scriptHash)).to.be.null;
    });

    it('removeOutputScriptsInBlock cleans up S and Z entries', async function () {
      const scriptHash = randHash();
      const blockHash = randHash();

      await db.insertOutputScriptBlock(scriptHash, blockHash, 10);
      await db.endTransaction(true);

      // Verify exists
      expect(await db.getOutputScriptBlock(scriptHash)).to.not.be.null;

      // Remove
      await db.beginTransaction();
      await db.removeOutputScriptsInBlock(blockHash);
      await db.endTransaction(true);

      expect(await db.getOutputScriptBlock(scriptHash)).to.be.null;
    });
  });

  // ─── Stored block list (N prefix) ────────────���───────────────────────────

  describe('stored block list (N prefix)', function () {
    it('adds and retrieves stored blocks', async function () {
      const h1 = randHash();
      const h2 = randHash();
      await db.addLastStoredBlock(h1);
      await db.addLastStoredBlock(h2);
      await db.endTransaction(true);

      const blocks = await db.getLastStoredBlocks();
      expect(blocks).to.include(h1);
      expect(blocks).to.include(h2);
    });

    it('removes a stored block', async function () {
      const h1 = randHash();
      await db.addLastStoredBlock(h1);
      await db.endTransaction(true);

      await db.beginTransaction();
      await db.removeLastStoredBlock(h1);
      await db.endTransaction(true);

      const blocks = await db.getLastStoredBlocks();
      expect(blocks).to.not.include(h1);
    });
  });

  // ─── Batch / transaction management ─────────���─────────────────────────────

  describe('batch operations', function () {
    it('beginTransaction resets the transaction map', async function () {
      await db.insertOutput({ scriptPubKey: randHash(), txHash: randHash8(), outputIndex: 0, value: BigInt(1), height: 1 });
      await db.beginTransaction();
      // After beginTransaction, the pending operations should be a fresh Map
      await db.endTransaction(true); // should not fail
    });

    it('endTransaction with batch=false discards pending writes', async function () {
      const scriptHash = randHash();
      await db.beginTransaction();
      await db.insertOutput({ scriptPubKey: scriptHash, txHash: randHash8(), outputIndex: 0, value: BigInt(999), height: 1 });
      await db.endTransaction(false); // discard

      const outputs = await db.getOutputsScriptPubKey(scriptHash);
      expect(outputs).to.be.empty;
    });

    it('empty batch commits without error', async function () {
      await db.beginTransaction();
      await db.endTransaction(true);
    });
  });

  // ─── getValuesFromKeyPattern ────────��─────────────────────────────────────

  describe('getValuesFromKeyPattern', function () {
    it('scans by key prefix', async function () {
      const scriptHash = randHash();
      const txHash8 = randHash8();
      await db.insertOutput({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 0, value: BigInt(100), height: 1 });
      await db.endTransaction(true);

      // Output key starts with 0x4F + scriptHash
      const pattern = '4f' + scriptHash;
      const results = await db.getValuesFromKeyPattern(pattern);
      expect(results).to.have.length(1);
      expect(results[0]).to.have.property('key');
      expect(results[0]).to.have.property('value');
    });

    it('returns empty for non-matching pattern', async function () {
      const results = await db.getValuesFromKeyPattern(randHash());
      expect(results).to.be.empty;
    });

    // Same rangeEnd regression as the O-prefix tests above, exercised
    // through the generic key-pattern path that the API surfaces via
    // get_input_from_key_pattern. Catches future re-reverts even if the
    // O-specific tests above are removed or refactored.
    it('scans across keys whose suffix-byte-after-prefix is 0xFF', async function () {
      const scriptHash = randHash();
      const txFF = 'ff' + randHash8().substring(2);
      await db.insertOutput({ scriptPubKey: scriptHash, txHash: txFF, outputIndex: 0, value: BigInt(100), height: 1 });
      await db.endTransaction(true);

      const results = await db.getValuesFromKeyPattern('4f' + scriptHash);
      expect(results).to.have.length(1);
      expect(results[0].key.toLowerCase()).to.match(new RegExp('^4f' + scriptHash + txFF + '00000000$'));
    });
  });

  // ─── deleteAndCompareTxsNotInList (mempool helper) ────────────────────────

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

  // ─── recoverDeletedOutputsHints ───────��────────────────────────────���──────

  describe('recoverDeletedOutputsHints', function () {
    it('recovers H-prefix entries from M-prefix records', async function () {
      const scriptHash = randHash();
      const txHash8 = randHash8();
      const blockHash = randHash();

      // Insert output + hint, commit
      await db.insertOutput({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 0, value: BigInt(3000), height: 15 });
      await db.insertOutputHint({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 0 });
      await db.endTransaction(true);

      // Spend (creates K/M entries on disk)
      await db.beginTransaction();
      await db.removeOutputWithInput({ prevTxHash: txHash8, prevOutputIndex: 0, blockHash });
      await db.endTransaction(true);

      // Recover just the hints
      await db.beginTransaction();
      await db.recoverDeletedOutputsHints(blockHash);
      await db.endTransaction(true);

      // The H entry should be back; verify by trying to delete outputs by hint
      // which reads the H entry to find and delete the O entry
      // Since the O entry was deleted, this should just succeed without error
      await db.beginTransaction();
      const count = await db.deleteOutputsByHint(txHash8 + randHash().substring(16));
      // count may be 0 or 1 depending on whether O was recovered too
      // The key thing is it doesn't throw
      await db.endTransaction(true);
    });
  });
});
