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
const sinon = require('sinon');
const {
  SATOSHI, TEST_KEYS,
  makeCoinbaseTx, makeBlock, makeOutput, makeSpendInput, makeTx,
  processBlock, processAndCommit, processBlocksAndCommit,
  createTestTracker, closeTracker,
  buildCommittedChain
} = require('./chaos-helpers');

describe('Chaos: Concurrency', function () {
  let tracker;

  beforeEach(async function () {
    tracker = await createTestTracker();
  });

  afterEach(async function () {
    sinon.restore();
    await closeTracker(tracker);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Experiment 10: Concurrent Query During Batch Commit (STATE-03)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Exp 10: Concurrent Queries During Batch Commit', function () {

    it('balance queries return valid results during endTransaction', async function () {
      // Baseline: 5 blocks of 50 BTC each to addr 0
      await buildCommittedChain(tracker, 5, 0);

      // Start a new batch with 3 more blocks to addr 0
      await tracker.db.beginTransaction();
      let prevHash = (await tracker.db.getLastBlockHash());
      for (let i = 5; i < 8; i++) {
        const block = makeBlock(i, prevHash, [makeCoinbaseTx(0)]);
        await processBlock(tracker, block);
        prevHash = block.hash;
      }

      // Fire 20 balance queries concurrently WITH the commit
      const queries = [];
      for (let i = 0; i < 20; i++) {
        queries.push(tracker.getBalanceInfo(TEST_KEYS[0].address));
      }
      const commit = tracker.db.endTransaction();

      const results = await Promise.all([commit, ...queries]);

      // All queries completed without throwing
      const queryResults = results.slice(1);
      for (const info of queryResults) {
        expect(info).to.have.nested.property('balances.confirmed');
        // Balance should be a valid decimal string
        expect(info.balances.confirmed).to.match(/^\d+\.\d{8}$/);
        // Should be either pre-commit (250) or post-commit (400) — never garbage
        const balance = parseFloat(info.balances.confirmed);
        expect(balance === 250 || balance === 400,
          `balance ${info.balances.confirmed} is neither pre-commit (250) nor post-commit (400)`
        ).to.be.true;
      }
    });

    it('post-commit queries reflect the committed state', async function () {
      await buildCommittedChain(tracker, 3, 0);

      await tracker.db.beginTransaction();
      const prevHash = await tracker.db.getLastBlockHash();
      const block3 = makeBlock(3, prevHash, [makeCoinbaseTx(1, 25 * SATOSHI)]);
      await processBlock(tracker, block3);

      // Commit first, then query
      await tracker.db.endTransaction();

      const info0 = await tracker.getBalanceInfo(TEST_KEYS[0].address);
      expect(info0.balances.confirmed).to.equal('150.00000000');

      const info1 = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(info1.balances.confirmed).to.equal('25.00000000');
    });

    it('UTXO queries return valid results during commit', async function () {
      await buildCommittedChain(tracker, 3, 0);

      await tracker.db.beginTransaction();
      const prevHash = await tracker.db.getLastBlockHash();
      for (let i = 3; i < 6; i++) {
        const block = makeBlock(i, prevHash, [makeCoinbaseTx(0)]);
        await processBlock(tracker, block);
      }

      // Concurrent UTXO queries and commit
      const queries = [];
      for (let i = 0; i < 10; i++) {
        queries.push(tracker.getUtxosAddress(TEST_KEYS[0].address));
      }

      const results = await Promise.all([tracker.db.endTransaction(), ...queries]);

      const utxoResults = results.slice(1);
      for (const utxos of utxoResults) {
        expect(utxos).to.be.an('array');
        // Each UTXO should have valid structure
        for (const utxo of utxos) {
          expect(utxo).to.have.property('txid');
          expect(utxo).to.have.property('vout');
          expect(utxo).to.have.property('value');
        }
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Experiment 8: Mempool Flood (RPC-06)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Exp 8: Mempool Flood', function () {

    it('large number of mempool transactions are indexed correctly', async function () {
      // Build 5 confirmed blocks, each with a coinbase to a different address
      // so we have 5 spendable UTXOs
      const blocks = [];
      let prevHash = '0'.repeat(64);
      for (let i = 0; i < 5; i++) {
        const block = makeBlock(i, prevHash, [makeCoinbaseTx(i, 100 * SATOSHI)]);
        blocks.push(block);
        prevHash = block.hash;
      }
      await processBlocksAndCommit(tracker, blocks);

      // Collect the coinbase txids for spending
      const coinbaseTxids = blocks.map(b => b.transactions[0]._txid);

      // Create 200 mempool transactions, each spending from one of the 5 UTXOs
      // and sending to addr 5
      const mempoolTxs = [];
      for (let i = 0; i < 200; i++) {
        const sourceIdx = i % 5;
        const tx = makeTx({
          ins: [makeSpendInput(coinbaseTxids[sourceIdx], 0)],
          outs: [makeOutput(5, 1 * SATOSHI)]
        });
        mempoolTxs.push(tx);
      }

      // Parse all mempool transactions into mempoolDb (simulating a flood)
      const dummyBlockHash = '0'.repeat(64);
      await tracker.mempoolDb.beginTransaction();
      for (const tx of mempoolTxs) {
        await tracker.parseTxOutputs(tracker.mempoolDb, tx, dummyBlockHash, -1, false, false);
        await tracker.parseTxInputs(tracker.mempoolDb, tx, dummyBlockHash, false, false);
      }
      await tracker.mempoolDb.endTransaction();

      // addr 5 should have pending balance from mempool outputs
      const info5 = await tracker.getBalanceInfo(TEST_KEYS[5].address);
      const pendingBalance = parseFloat(info5.balances.pending);
      expect(pendingBalance).to.be.greaterThan(0);
      expect(info5.utxos.pending).to.be.greaterThan(0);

      // Confirmed balances on the main db are untouched
      for (let i = 0; i < 5; i++) {
        const info = await tracker.getBalanceInfo(TEST_KEYS[i].address);
        expect(info.balances.confirmed).to.equal('100.00000000');
      }
    });

    it('mempool flood does not corrupt confirmed UTXO state', async function () {
      await buildCommittedChain(tracker, 10, 0);

      // Flood mempoolDb with 100 transactions
      await tracker.mempoolDb.beginTransaction();
      for (let i = 0; i < 100; i++) {
        const tx = makeTx({
          ins: [makeSpendInput('ff'.repeat(32), i)],
          outs: [makeOutput(1, 5 * SATOSHI)]
        });
        await tracker.parseTxOutputs(tracker.mempoolDb, tx, '0'.repeat(64), -1, false, false);
      }
      await tracker.mempoolDb.endTransaction();

      // Confirmed state is entirely unaffected
      const info = await tracker.getBalanceInfo(TEST_KEYS[0].address);
      expect(info.balances.confirmed).to.equal('500.00000000');
      expect(info.utxos.confirmed).to.equal(10);

      // The main DB height is unchanged
      expect(await tracker.db.getLastBlockHeight()).to.equal(9);
    });

    it('new confirmed blocks can be processed after mempool flood', async function () {
      const blocks = await buildCommittedChain(tracker, 3, 0);

      // Flood mempool
      await tracker.mempoolDb.beginTransaction();
      for (let i = 0; i < 50; i++) {
        const tx = makeTx({
          ins: [makeSpendInput('ee'.repeat(32), i)],
          outs: [makeOutput(2, 1 * SATOSHI)]
        });
        await tracker.parseTxOutputs(tracker.mempoolDb, tx, '0'.repeat(64), -1, false, false);
      }
      await tracker.mempoolDb.endTransaction();

      // Process new confirmed block after mempool flood
      const block3 = makeBlock(3, blocks[2].hash, [makeCoinbaseTx(0, 25 * SATOSHI)]);
      await processAndCommit(tracker, block3);

      expect(await tracker.db.getLastBlockHeight()).to.equal(3);
      const info = await tracker.getBalanceInfo(TEST_KEYS[0].address);
      expect(info.balances.confirmed).to.equal('175.00000000');
    });
  });
});
