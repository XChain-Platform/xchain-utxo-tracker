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
const {
  SATOSHI, TEST_KEYS,
  makeOutput, makeSpendInput, makeTx, makeCoinbaseTx,
  makeBlock, processAndCommit, processBlocksAndCommit,
  createTestTracker, closeTracker,
  coinAmount, sumAmounts
} = require('./helpers');

describe('Integration: Mempool', function () {
  let tracker;

  beforeEach(async function () {
    tracker = await createTestTracker();
  });

  afterEach(async function () {
    await closeTracker(tracker);
  });

  // Mimics updateMempool: parses a transaction into the mempool DB.
  async function addToMempool(tx) {
    await tracker.mempoolDb.beginTransaction();
    await tracker.parseTransaction(tracker.mempoolDb, tx, null, -1, true);
    await tracker.mempoolDb.endTransaction();
  }

  // Simulates a mempool update that clears stale transactions.
  async function resetMempool() {
    await tracker.mempoolDb.close();
    const LevelUpStore = require('../../src/LevelUpDb');
    tracker.mempoolDb = new LevelUpStore('mempool-reset-' + Date.now() + '-' + Math.random(), true);
    await tracker.mempoolDb.createDatabase();
  }

  describe('mempool outputs appear as pending', function () {
    it('shows unconfirmed outputs in pending balance', async function () {
      const coinbaseTx = makeCoinbaseTx(0, 50 * SATOSHI);
      const block0 = makeBlock(0, '0'.repeat(64), [coinbaseTx]);
      await processAndCommit(tracker, block0);

      const mempoolTx = makeTx({
        ins: [makeSpendInput(coinbaseTx._txid, 0)],
        outs: [
          makeOutput(1, 10 * SATOSHI),
          makeOutput(0, 3999000000)
        ]
      });
      await addToMempool(mempoolTx);

      const info1 = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(info1.balances.confirmed).to.equal('0.00000000');
      expect(info1.balances.pending).to.equal('10.00000000');
      expect(info1.utxos.pending).to.equal(1);

      const info0 = await tracker.getBalanceInfo(TEST_KEYS[0].address);
      expect(info0.balances.confirmed).to.equal('50.00000000');
      // pending is the signed net movement: -50 spent + 39.99 change back.
      expect(info0.balances.pending).to.equal(coinAmount('-10.01'));
      // The change output itself is still counted as a pending UTXO.
      expect(info0.utxos.pending).to.equal(1);
    });
  });

  describe('mempool transaction gets confirmed', function () {
    it('moves balance from pending to confirmed', async function () {
      const coinbaseTx = makeCoinbaseTx(0, 50 * SATOSHI);
      const block0 = makeBlock(0, '0'.repeat(64), [coinbaseTx]);
      await processAndCommit(tracker, block0);

      const spendTx = makeTx({
        ins: [makeSpendInput(coinbaseTx._txid, 0)],
        outs: [makeOutput(1, 10 * SATOSHI), makeOutput(0, 3999000000)]
      });
      await addToMempool(spendTx);

      const infoBefore = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(infoBefore.balances.pending).to.equal('10.00000000');

      const block1 = makeBlock(1, block0.hash, [makeCoinbaseTx(2), spendTx]);
      await processAndCommit(tracker, block1);
      await resetMempool();

      const infoAfter = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(infoAfter.balances.confirmed).to.equal('10.00000000');
      expect(infoAfter.balances.pending).to.equal('0.00000000');

      const info0 = await tracker.getBalanceInfo(TEST_KEYS[0].address);
      expect(info0.balances.confirmed).to.equal('39.99000000');
      expect(info0.balances.pending).to.equal('0.00000000');
    });
  });

  describe('mempool transaction dropped', function () {
    it('restores original balance when mempool tx disappears', async function () {
      const coinbaseTx = makeCoinbaseTx(0, 50 * SATOSHI);
      const block0 = makeBlock(0, '0'.repeat(64), [coinbaseTx]);
      await processAndCommit(tracker, block0);

      const mempoolTx = makeTx({
        ins: [makeSpendInput(coinbaseTx._txid, 0)],
        outs: [makeOutput(1, 10 * SATOSHI)]
      });
      await addToMempool(mempoolTx);

      const infoPending = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(infoPending.balances.pending).to.equal('10.00000000');

      await resetMempool();

      const info0 = await tracker.getBalanceInfo(TEST_KEYS[0].address);
      expect(info0.balances.confirmed).to.equal('50.00000000');
      expect(info0.balances.pending).to.equal('0.00000000');

      const info1 = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(info1.balances.confirmed).to.equal('0.00000000');
      expect(info1.balances.pending).to.equal('0.00000000');
    });
  });

  describe('multiple mempool transactions', function () {
    it('tracks pending from multiple unconfirmed txs to different addresses', async function () {
      const cb0 = makeCoinbaseTx(0, 20 * SATOSHI);
      const cb1 = makeCoinbaseTx(0, 30 * SATOSHI);
      const block0 = makeBlock(0, '0'.repeat(64), [cb0]);
      const block1 = makeBlock(1, block0.hash, [cb1]);
      await processBlocksAndCommit(tracker, [block0, block1]);

      const mempoolTx1 = makeTx({
        ins: [makeSpendInput(cb0._txid, 0)],
        outs: [makeOutput(1, 5 * SATOSHI)]
      });
      const mempoolTx2 = makeTx({
        ins: [makeSpendInput(cb1._txid, 0)],
        outs: [makeOutput(2, 8 * SATOSHI)]
      });

      await addToMempool(mempoolTx1);
      await addToMempool(mempoolTx2);

      const info1 = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(info1.balances.pending).to.equal('5.00000000');

      const info2 = await tracker.getBalanceInfo(TEST_KEYS[2].address);
      expect(info2.balances.pending).to.equal('8.00000000');
    });
  });

  describe('mempool output for new address', function () {
    it('shows pending balance for address with no confirmed history', async function () {
      const coinbaseTx = makeCoinbaseTx(0, 50 * SATOSHI);
      const block0 = makeBlock(0, '0'.repeat(64), [coinbaseTx]);
      await processAndCommit(tracker, block0);

      const mempoolTx = makeTx({
        ins: [makeSpendInput(coinbaseTx._txid, 0)],
        outs: [makeOutput(3, 7 * SATOSHI)]
      });
      await addToMempool(mempoolTx);

      const info3 = await tracker.getBalanceInfo(TEST_KEYS[3].address);
      expect(info3.balances.confirmed).to.equal('0.00000000');
      expect(info3.balances.pending).to.equal('7.00000000');
      expect(info3.utxos.confirmed).to.equal(0);
      expect(info3.utxos.pending).to.equal(1);

      // getUtxosAddress also surfaces the mempool UTXO, not just getBalanceInfo.
      const utxos3 = await tracker.getUtxosAddress(TEST_KEYS[3].address);
      expect(utxos3).to.have.length(1);
      expect(utxos3[0].confirmations).to.equal(0);
      expect(utxos3[0].amount).to.equal(coinAmount(7));
    });
  });
});
