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
const sinon = require('sinon');
const {
  SATOSHI, TEST_KEYS,
  makeOutput, makeSpendInput, makeTx, makeCoinbaseTx,
  makeBlock, buildCoinbaseChain, buildChainFromSpecs,
  stubBlockchain, addBlockToState,
  sleep, waitForHeight, waitForSynced,
  createE2ETracker, patchLevelUpStoreInMemory
} = require('./helpers');

describe('E2E: Lifecycle — start() Loop', function () {
  let tracker;
  let restoreLevelUp;

  beforeEach(function () {
    restoreLevelUp = patchLevelUpStoreInMemory();
    tracker = createE2ETracker();
  });

  afterEach(async function () {
    sinon.restore();
    await tracker.stopParsing();
    restoreLevelUp();
  });

  // ─── E2E-A1: Genesis to Synced ─────────────────────────────────────────

  describe('A1: genesis to synced state', function () {
    it('syncs 5 blocks and reports correct height and balances', async function () {
      const blocks = buildCoinbaseChain(5, 0);
      const state = stubBlockchain(tracker, blocks);

      tracker.start();
      await waitForSynced(tracker);

      expect(tracker.synced).to.be.true;
      expect(await tracker.db.getLastBlockHeight()).to.equal(4);
      expect(await tracker.db.getLastBlockHash()).to.equal(blocks[4].hash);

      const info = await tracker.getBalanceInfo(TEST_KEYS[0].address);
      expect(info.balances.confirmed).to.equal('250.00000000');
      expect(info.utxos.confirmed).to.equal(5);

      const utxos = await tracker.getUtxosAddress(TEST_KEYS[0].address);
      expect(utxos).to.have.length(5);
    });
  });

  // ─── E2E-A2: Incremental Block Processing ─────────────────────────────

  describe('A2: incremental block processing', function () {
    it('picks up new blocks after reaching synced state', async function () {
      const blocks = buildCoinbaseChain(3, 0);
      const state = stubBlockchain(tracker, blocks);

      tracker.start();
      await waitForSynced(tracker);

      expect(await tracker.db.getLastBlockHeight()).to.equal(2);

      // Add 3 more blocks to a different address
      for (let i = 3; i < 6; i++) {
        const prevHash = state.blocks[state.blocks.length - 1].hash;
        const newBlock = makeBlock(i, prevHash, [makeCoinbaseTx(1, 10 * SATOSHI)]);
        addBlockToState(state, newBlock);
      }

      await waitForHeight(tracker, 5);

      const info0 = await tracker.getBalanceInfo(TEST_KEYS[0].address);
      expect(info0.balances.confirmed).to.equal('150.00000000');

      const info1 = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(info1.balances.confirmed).to.equal('30.00000000');
      expect(info1.utxos.confirmed).to.equal(3);
    });
  });

  // ─── E2E-A3: Multi-Address Distribution ────────────────────────────────

  describe('A3: multi-address distribution', function () {
    it('indexes multi-output transaction with correct per-address balances', async function () {
      // Block 0: coinbase 50 BTC to addr 0
      const cb = makeCoinbaseTx(0, 50 * SATOSHI);
      const block0 = makeBlock(0, '0'.repeat(64), [cb]);

      // Block 1: spend coinbase, distribute to 4 addresses
      const spendTx = makeTx({
        ins: [makeSpendInput(cb._txid, 0)],
        outs: [
          makeOutput(1, 10 * SATOSHI),
          makeOutput(2, 15 * SATOSHI),
          makeOutput(3, 12 * SATOSHI),
          makeOutput(4, 8 * SATOSHI)   // 10+15+12+8 = 45, 5 BTC fee
        ]
      });
      const block1 = makeBlock(1, block0.hash, [makeCoinbaseTx(5), spendTx]);

      const state = stubBlockchain(tracker, [block0, block1]);
      tracker.start();
      await waitForSynced(tracker);

      // Verify each recipient
      const expected = [
        { addr: 1, balance: '10.00000000', count: 1 },
        { addr: 2, balance: '15.00000000', count: 1 },
        { addr: 3, balance: '12.00000000', count: 1 },
        { addr: 4, balance: '8.00000000', count: 1 }
      ];

      for (const e of expected) {
        const info = await tracker.getBalanceInfo(TEST_KEYS[e.addr].address);
        expect(info.balances.confirmed, `addr ${e.addr}`).to.equal(e.balance);
        expect(info.utxos.confirmed, `addr ${e.addr} count`).to.equal(e.count);
      }

      // Sender should have 0 (spent)
      const info0 = await tracker.getBalanceInfo(TEST_KEYS[0].address);
      expect(info0.balances.confirmed).to.equal('0.00000000');
    });
  });

  // ─── E2E-A4: Large Batch (150+ Blocks) ────────────────────────────────

  describe('A4: large batch forcing multiple DB_TRANSACTION_BLOCKS_QUANTITY commits', function () {
    it('indexes 150 blocks across batch boundaries without data loss', async function () {
      const blocks = buildCoinbaseChain(150, 0, 0, 1 * SATOSHI);
      const state = stubBlockchain(tracker, blocks);

      tracker.start();
      await waitForHeight(tracker, 149, 60000);

      expect(await tracker.db.getLastBlockHeight()).to.equal(149);

      // 150 coinbase outputs of 1 BTC each (1 * SATOSHI = 100000000 sats)
      const info = await tracker.getBalanceInfo(TEST_KEYS[0].address);
      expect(info.balances.confirmed).to.equal('150.00000000');
      expect(info.utxos.confirmed).to.equal(150);

      // Verify blocks at batch boundaries exist
      const block99 = await tracker.db.getBlock(blocks[99].hash);
      expect(block99).to.not.be.null;
      expect(block99.h).to.equal(99);

      const block100 = await tracker.db.getBlock(blocks[100].hash);
      expect(block100).to.not.be.null;
      expect(block100.h).to.equal(100);
    });
  });

  // ─── E2E-B1: Simple Spend Through the Loop ────────────────────────────

  describe('B1: simple spend through the loop', function () {
    it('processes spend and updates balances correctly', async function () {
      const cb = makeCoinbaseTx(0, 50 * SATOSHI);
      const block0 = makeBlock(0, '0'.repeat(64), [cb]);

      const spendTx = makeTx({
        ins: [makeSpendInput(cb._txid, 0)],
        outs: [
          makeOutput(1, 10 * SATOSHI),
          makeOutput(0, 3999000000)  // 39.99 BTC change
        ]
      });
      const block1 = makeBlock(1, block0.hash, [makeCoinbaseTx(2), spendTx]);

      const state = stubBlockchain(tracker, [block0, block1]);
      tracker.start();
      await waitForSynced(tracker);

      const info0 = await tracker.getBalanceInfo(TEST_KEYS[0].address);
      expect(info0.balances.confirmed).to.equal('39.99000000');
      expect(info0.utxos.confirmed).to.equal(1);

      const info1 = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(info1.balances.confirmed).to.equal('10.00000000');
      expect(info1.utxos.confirmed).to.equal(1);
    });
  });

  // ─── E2E-B2: Drain Address ─────────────────────────────────────────────

  describe('B2: drain address (spend all UTXOs)', function () {
    it('leaves sender with zero balance after spending all UTXOs', async function () {
      // 3 coinbases to addr 0
      const cb0 = makeCoinbaseTx(0, 10 * SATOSHI);
      const cb1 = makeCoinbaseTx(0, 20 * SATOSHI);
      const cb2 = makeCoinbaseTx(0, 30 * SATOSHI);
      const block0 = makeBlock(0, '0'.repeat(64), [cb0]);
      const block1 = makeBlock(1, block0.hash, [cb1]);
      const block2 = makeBlock(2, block1.hash, [cb2]);

      // Block 3: spend all 3 UTXOs to addr 1
      const drainTx = makeTx({
        ins: [
          makeSpendInput(cb0._txid, 0),
          makeSpendInput(cb1._txid, 0),
          makeSpendInput(cb2._txid, 0)
        ],
        outs: [makeOutput(1, 59 * SATOSHI)]  // 60 - 1 fee
      });
      const block3 = makeBlock(3, block2.hash, [makeCoinbaseTx(2), drainTx]);

      const state = stubBlockchain(tracker, [block0, block1, block2, block3]);
      tracker.start();
      await waitForSynced(tracker);

      const info0 = await tracker.getBalanceInfo(TEST_KEYS[0].address);
      expect(info0.balances.confirmed).to.equal('0.00000000');
      expect(info0.utxos.confirmed).to.equal(0);

      const info1 = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(info1.balances.confirmed).to.equal('59.00000000');
    });
  });

  // ─── E2E-B3: Same-Block Spend ──────────────────────────────────────────

  describe('B3: same-block spend through the loop', function () {
    it('handles output created and spent in the same block', async function () {
      const cb = makeCoinbaseTx(0, 50 * SATOSHI);
      const block0 = makeBlock(0, '0'.repeat(64), [cb]);

      // tx1 sends to addr1, tx2 spends addr1's output in the same block
      const tx1 = makeTx({
        ins: [makeSpendInput(cb._txid, 0)],
        outs: [makeOutput(1, 25 * SATOSHI)]
      });
      const tx2 = makeTx({
        ins: [makeSpendInput(tx1._txid, 0)],
        outs: [makeOutput(2, 24 * SATOSHI)]
      });
      const block1 = makeBlock(1, block0.hash, [makeCoinbaseTx(3), tx1, tx2]);

      const state = stubBlockchain(tracker, [block0, block1]);
      tracker.start();
      await waitForSynced(tracker);

      // addr1: created and spent in same block = 0
      const info1 = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(info1.balances.confirmed).to.equal('0.00000000');

      // addr2: received from tx2
      const info2 = await tracker.getBalanceInfo(TEST_KEYS[2].address);
      expect(info2.balances.confirmed).to.equal('24.00000000');
    });
  });

  // ─── E2E-A5: Confirmations ─────────────────────────────────────────────

  describe('A5: confirmation count calculation', function () {
    it('returns correct confirmations based on tip height', async function () {
      const blocks = buildCoinbaseChain(10, 0, 0, 5 * SATOSHI);
      const state = stubBlockchain(tracker, blocks);

      tracker.start();
      await waitForSynced(tracker);

      const utxos = await tracker.getUtxosAddress(TEST_KEYS[0].address);
      expect(utxos).to.have.length(10);

      // Block 0 at tip 9 => 10 confirmations
      const block0Utxo = utxos.find(u => u.height === 0);
      expect(block0Utxo.confirmations).to.equal(10);

      // Block 9 at tip 9 => 1 confirmation
      const block9Utxo = utxos.find(u => u.height === 9);
      expect(block9Utxo.confirmations).to.equal(1);
    });
  });

  // ─── E2E-A6: Empty Address Query ───────────────────────────────────────

  describe('A6: empty address queries', function () {
    it('returns zero balances for addresses with no history', async function () {
      const blocks = buildCoinbaseChain(3, 0);
      const state = stubBlockchain(tracker, blocks);

      tracker.start();
      await waitForSynced(tracker);

      const info = await tracker.getBalanceInfo(TEST_KEYS[5].address);
      expect(info.balances.confirmed).to.equal('0.00000000');
      expect(info.balances.pending).to.equal('0.00000000');
      expect(info.utxos.confirmed).to.equal(0);

      const utxos = await tracker.getUtxosAddress(TEST_KEYS[5].address);
      expect(utxos).to.have.length(0);
    });
  });

  // ─── E2E-A7: First Seen ────────────────────────────────────────────────

  describe('A7: first-seen tracking', function () {
    it('returns the first block height for an address', async function () {
      const blocks = buildCoinbaseChain(5, 0);
      const state = stubBlockchain(tracker, blocks);

      tracker.start();
      await waitForSynced(tracker);

      const firstSeen = await tracker.getFirstSeen(TEST_KEYS[0].address);
      expect(firstSeen).to.deep.equal({ height: 0 });
    });

    it('returns null for address with no history', async function () {
      const blocks = buildCoinbaseChain(3, 0);
      const state = stubBlockchain(tracker, blocks);

      tracker.start();
      await waitForSynced(tracker);

      const firstSeen = await tracker.getFirstSeen(TEST_KEYS[5].address);
      expect(firstSeen).to.be.null;
    });
  });
});
