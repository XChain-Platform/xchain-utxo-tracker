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

const { expect } = require('chai');
const {
  SATOSHI, TEST_KEYS,
  makeOutput, makeCoinbaseInput, makeSpendInput, makeTx, makeCoinbaseTx,
  makeBlock, processAndCommit, processBlocksAndCommit,
  createTestTracker, closeTracker, randHash
} = require('./helpers');

describe('Integration: Core Indexing', function () {
  let tracker;

  beforeEach(async function () {
    tracker = await createTestTracker();
  });

  afterEach(async function () {
    await closeTracker(tracker);
  });

  // ─── Scenario 1.1: Coinbase-Only Block ─────────────────────────────────

  describe('coinbase-only block', function () {
    it('indexes coinbase output and returns correct UTXO/balance', async function () {
      const coinbaseTx = makeCoinbaseTx(0, 50 * SATOSHI);
      const block = makeBlock(0, '0'.repeat(64), [coinbaseTx]);

      await processAndCommit(tracker, block);

      // Verify via getUtxosAddress
      const utxos = await tracker.getUtxosAddress(TEST_KEYS[0].address);
      expect(utxos).to.have.length(1);
      expect(utxos[0].amount).to.equal(50);
      expect(utxos[0].vout).to.equal(0);

      // Verify via getBalanceInfo
      const info = await tracker.getBalanceInfo(TEST_KEYS[0].address);
      expect(info.balances.confirmed).to.equal('50.00000000');
      expect(info.balances.pending).to.equal('0.00000000');
      expect(info.utxos.confirmed).to.equal(1);
      expect(info.utxos.pending).to.equal(0);
    });

    it('persists B record with correct height/timestamp/prevHash', async function () {
      const prevHash = '0'.repeat(64);
      const coinbaseTx = makeCoinbaseTx(0);
      const block = makeBlock(0, prevHash, [coinbaseTx]);

      await processAndCommit(tracker, block);

      const stored = await tracker.db.getBlock(block.hash);
      expect(stored).to.not.be.null;
      expect(stored.h).to.equal(0);
      expect(stored.t).to.equal(block.timestamp);
      expect(stored.ph).to.equal(prevHash);
    });

    it('does not create I records for coinbase input', async function () {
      const coinbaseTx = makeCoinbaseTx(0);
      const txid8 = coinbaseTx._txid.substring(0, 16);
      const block = makeBlock(0, '0'.repeat(64), [coinbaseTx]);

      await processAndCommit(tracker, block);

      // Coinbase index is 0xFFFFFFFF — no I record should exist
      const input = await tracker.db.getInput(txid8, 4294967295);
      expect(input).to.be.null;
    });

    it('creates S record for first script appearance', async function () {
      const coinbaseTx = makeCoinbaseTx(0);
      const block = makeBlock(0, '0'.repeat(64), [coinbaseTx]);

      await processAndCommit(tracker, block);

      const scriptBlock = await tracker.db.getOutputScriptBlock(TEST_KEYS[0].scriptHash);
      expect(scriptBlock).to.not.be.null;
      expect(scriptBlock.h).to.equal(0);
    });

    it('returns no UTXOs for an address that received nothing', async function () {
      const coinbaseTx = makeCoinbaseTx(0);
      const block = makeBlock(0, '0'.repeat(64), [coinbaseTx]);

      await processAndCommit(tracker, block);

      const utxos = await tracker.getUtxosAddress(TEST_KEYS[1].address);
      expect(utxos).to.have.length(0);

      const info = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(info.balances.confirmed).to.equal('0.00000000');
    });
  });

  // ─── Scenario 1.2: Simple Transfer ────────────────────────────────────

  describe('simple transfer (spend + change)', function () {
    it('updates balances correctly after spend', async function () {
      // Block 0: coinbase 50 BTC to address 0
      const coinbaseTx = makeCoinbaseTx(0, 50 * SATOSHI);
      const block0 = makeBlock(0, '0'.repeat(64), [coinbaseTx]);

      // Block 1: spend coinbase, send 10 to addr1, 39.99 change to addr0
      const spendTx = makeTx({
        ins: [makeSpendInput(coinbaseTx._txid, 0)],
        outs: [
          makeOutput(1, 10 * SATOSHI),        // 10 BTC to address 1
          makeOutput(0, 3999000000)            // 39.99 BTC change to address 0
        ]
      });
      const block1 = makeBlock(1, block0.hash, [makeCoinbaseTx(2), spendTx]);

      await processBlocksAndCommit(tracker, [block0, block1]);

      // Address 0: original 50 BTC spent, only has 39.99 BTC change
      const info0 = await tracker.getBalanceInfo(TEST_KEYS[0].address);
      expect(info0.balances.confirmed).to.equal('39.99000000');
      expect(info0.utxos.confirmed).to.equal(1);

      const utxos0 = await tracker.getUtxosAddress(TEST_KEYS[0].address);
      expect(utxos0).to.have.length(1);
      expect(utxos0[0].amount).to.equal(39.99);

      // Address 1: received 10 BTC
      const info1 = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(info1.balances.confirmed).to.equal('10.00000000');
      expect(info1.utxos.confirmed).to.equal(1);
    });

    it('getFirstSeen returns first-seen block for recipient', async function () {
      const coinbaseTx = makeCoinbaseTx(0, 50 * SATOSHI);
      const block0 = makeBlock(0, '0'.repeat(64), [coinbaseTx]);

      const spendTx = makeTx({
        ins: [makeSpendInput(coinbaseTx._txid, 0)],
        outs: [makeOutput(1, 10 * SATOSHI), makeOutput(0, 3999000000)]
      });
      const block1 = makeBlock(1, block0.hash, [makeCoinbaseTx(2), spendTx]);

      await processBlocksAndCommit(tracker, [block0, block1]);

      const firstSeen = await tracker.getFirstSeen(TEST_KEYS[1].address);
      expect(firstSeen).to.deep.equal({ height: 1 });
    });
  });

  // ─── Scenario 1.3: Multi-Output Transaction ──────────────────────────

  describe('multi-output transaction', function () {
    it('creates separate UTXOs for each output address', async function () {
      const coinbaseTx = makeCoinbaseTx(0, 50 * SATOSHI);
      const block0 = makeBlock(0, '0'.repeat(64), [coinbaseTx]);

      // Tx with 5 outputs to 5 different addresses
      const multiTx = makeTx({
        ins: [makeSpendInput(coinbaseTx._txid, 0)],
        outs: [
          makeOutput(1, 5 * SATOSHI),
          makeOutput(2, 10 * SATOSHI),
          makeOutput(3, 15 * SATOSHI),
          makeOutput(4, 8 * SATOSHI),
          makeOutput(5, 11 * SATOSHI)   // 5+10+15+8+11 = 49 BTC (1 BTC fee)
        ]
      });
      const block1 = makeBlock(1, block0.hash, [makeCoinbaseTx(6), multiTx]);

      await processBlocksAndCommit(tracker, [block0, block1]);

      // Check each recipient
      const amounts = [5, 10, 15, 8, 11];
      for (let i = 0; i < 5; i++) {
        const utxos = await tracker.getUtxosAddress(TEST_KEYS[i + 1].address);
        expect(utxos, `address ${i + 1}`).to.have.length(1);
        expect(utxos[0].amount, `address ${i + 1} amount`).to.equal(amounts[i]);
        expect(utxos[0].vout, `address ${i + 1} vout`).to.equal(i);
      }
    });
  });

  // ─── Scenario 1.4: Same-Block Spend ───────────────────────────────────

  describe('same-block spend', function () {
    it('handles output created and spent in the same block', async function () {
      // Block 0: coinbase to addr0
      const coinbaseTx = makeCoinbaseTx(0, 50 * SATOSHI);
      const block0 = makeBlock(0, '0'.repeat(64), [coinbaseTx]);
      await processAndCommit(tracker, block0);

      // Block 1: tx1 sends to addr1, tx2 spends addr1's output in the same block
      const tx1 = makeTx({
        ins: [makeSpendInput(coinbaseTx._txid, 0)],
        outs: [makeOutput(1, 25 * SATOSHI)]
      });

      const tx2 = makeTx({
        ins: [makeSpendInput(tx1._txid, 0)],
        outs: [makeOutput(2, 24 * SATOSHI)]
      });

      const block1 = makeBlock(1, block0.hash, [makeCoinbaseTx(3), tx1, tx2]);
      await processAndCommit(tracker, block1);

      // Address 1: output was created by tx1 and spent by tx2 — should have 0 UTXOs
      const utxos1 = await tracker.getUtxosAddress(TEST_KEYS[1].address);
      expect(utxos1).to.have.length(0);

      const info1 = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(info1.balances.confirmed).to.equal('0.00000000');

      // Address 2: received 24 BTC from tx2
      const utxos2 = await tracker.getUtxosAddress(TEST_KEYS[2].address);
      expect(utxos2).to.have.length(1);
      expect(utxos2[0].amount).to.equal(24);
    });
  });

  // ─── Scenario 1.5: Multiple UTXOs for Same Address ────────────────────

  describe('multiple UTXOs for same address', function () {
    it('accumulates UTXOs across blocks', async function () {
      const prevHash = '0'.repeat(64);

      // 3 blocks, each with a coinbase sending to address 0
      const block0 = makeBlock(0, prevHash, [makeCoinbaseTx(0, 10 * SATOSHI)]);
      const block1 = makeBlock(1, block0.hash, [makeCoinbaseTx(0, 20 * SATOSHI)]);
      const block2 = makeBlock(2, block1.hash, [makeCoinbaseTx(0, 30 * SATOSHI)]);

      await processBlocksAndCommit(tracker, [block0, block1, block2]);

      const utxos = await tracker.getUtxosAddress(TEST_KEYS[0].address);
      expect(utxos).to.have.length(3);

      const totalAmount = utxos.reduce((sum, u) => sum + u.amount, 0);
      expect(totalAmount).to.equal(60); // 10 + 20 + 30

      const info = await tracker.getBalanceInfo(TEST_KEYS[0].address);
      expect(info.balances.confirmed).to.equal('60.00000000');
      expect(info.utxos.confirmed).to.equal(3);
    });

    it('getFirstSeen returns the first block height', async function () {
      const block0 = makeBlock(0, '0'.repeat(64), [makeCoinbaseTx(0, 10 * SATOSHI)]);
      const block1 = makeBlock(1, block0.hash, [makeCoinbaseTx(0, 20 * SATOSHI)]);

      await processBlocksAndCommit(tracker, [block0, block1]);

      const firstSeen = await tracker.getFirstSeen(TEST_KEYS[0].address);
      expect(firstSeen).to.deep.equal({ height: 0 });
    });
  });

  // ─── Scenario 1.6: Spending One of Multiple UTXOs ─────────────────────

  describe('spending one of multiple UTXOs', function () {
    it('removes only the spent UTXO', async function () {
      // Create 3 UTXOs for address 0
      const cb0 = makeCoinbaseTx(0, 10 * SATOSHI);
      const cb1 = makeCoinbaseTx(0, 20 * SATOSHI);
      const cb2 = makeCoinbaseTx(0, 30 * SATOSHI);

      const block0 = makeBlock(0, '0'.repeat(64), [cb0]);
      const block1 = makeBlock(1, block0.hash, [cb1]);
      const block2 = makeBlock(2, block1.hash, [cb2]);

      await processBlocksAndCommit(tracker, [block0, block1, block2]);

      // Spend only the middle UTXO (cb1, 20 BTC)
      const spendTx = makeTx({
        ins: [makeSpendInput(cb1._txid, 0)],
        outs: [makeOutput(1, 19 * SATOSHI)]
      });
      const block3 = makeBlock(3, block2.hash, [makeCoinbaseTx(2), spendTx]);

      await processAndCommit(tracker, block3);

      // Address 0: should have 2 UTXOs (10 + 30 = 40 BTC)
      const utxos = await tracker.getUtxosAddress(TEST_KEYS[0].address);
      expect(utxos).to.have.length(2);

      const totalAmount = utxos.reduce((sum, u) => sum + u.amount, 0);
      expect(totalAmount).to.equal(40);

      const info = await tracker.getBalanceInfo(TEST_KEYS[0].address);
      expect(info.balances.confirmed).to.equal('40.00000000');
      expect(info.utxos.confirmed).to.equal(2);

      // Address 1: received 19 BTC
      const info1 = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(info1.balances.confirmed).to.equal('19.00000000');
    });
  });

  // ─── Scenario 1.7: Confirmations calculation ─────────────────────────

  describe('confirmations', function () {
    it('calculates correct confirmation count', async function () {
      tracker.blockchainInfoLastBlock = 10;

      const block0 = makeBlock(0, '0'.repeat(64), [makeCoinbaseTx(0, 10 * SATOSHI)]);
      const block5 = makeBlock(5, block0.hash, [makeCoinbaseTx(0, 20 * SATOSHI)]);

      await processBlocksAndCommit(tracker, [block0, block5]);

      const utxos = await tracker.getUtxosAddress(TEST_KEYS[0].address);
      expect(utxos).to.have.length(2);

      // Block 0 at tip 10 => 11 confirmations
      const block0Utxo = utxos.find(u => u.height === 0);
      expect(block0Utxo.confirmations).to.equal(11);

      // Block 5 at tip 10 => 6 confirmations
      const block5Utxo = utxos.find(u => u.height === 5);
      expect(block5Utxo.confirmations).to.equal(6);
    });
  });
});
