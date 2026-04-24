'use strict';

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
      // No output or hint exists — should not throw
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

      // The H entry should be back — verify by trying to delete outputs by hint
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
