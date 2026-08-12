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
  makeOutput, makeSpendInput, makeTx, makeCoinbaseTx,
  makeBlock, buildCoinbaseChain,
  stubBlockchain, addBlockToState, addMempoolTx, removeMempoolTx, clearMempool,
  sleep, waitForHeight, waitForSynced,
  createE2ETracker, patchLevelUpStoreInMemory
} = require('./helpers');

describe('E2E: Mempool Lifecycle', function () {
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

  describe('C1: mempool detection', function () {
    it('shows pending balance after updateMempool() processes a new tx', async function () {
      const cb = makeCoinbaseTx(0, 50 * SATOSHI);
      const block0 = makeBlock(0, '0'.repeat(64), [cb]);
      const state = stubBlockchain(tracker, [block0]);

      tracker.start();
      await waitForSynced(tracker);

      const mempoolTx = makeTx({
        ins: [makeSpendInput(cb._txid, 0)],
        outs: [
          makeOutput(1, 10 * SATOSHI),
          makeOutput(0, 3999000000)
        ]
      });
      addMempoolTx(state, mempoolTx);

      // Call updateMempool() directly rather than waiting on the 60s poll interval.
      await tracker.updateMempool();

      const info1 = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(info1.balances.confirmed).to.equal('0.00000000');
      expect(info1.balances.pending).to.equal('10.00000000');
      expect(info1.utxos.pending).to.equal(1);

      const info0 = await tracker.getBalanceInfo(TEST_KEYS[0].address);
      expect(info0.balances.confirmed).to.equal('50.00000000');
      expect(parseFloat(info0.balances.pending)).to.be.greaterThan(0);
    });
  });

  describe('C2: mempool to confirmed transition', function () {
    it('moves balance from pending to confirmed when tx is mined', async function () {
      const cb = makeCoinbaseTx(0, 50 * SATOSHI);
      const block0 = makeBlock(0, '0'.repeat(64), [cb]);
      const state = stubBlockchain(tracker, [block0]);

      tracker.start();
      await waitForSynced(tracker);

      const spendTx = makeTx({
        ins: [makeSpendInput(cb._txid, 0)],
        outs: [makeOutput(1, 10 * SATOSHI), makeOutput(0, 3999000000)]
      });
      addMempoolTx(state, spendTx);
      await tracker.updateMempool();

      const infoBefore = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(infoBefore.balances.pending).to.equal('10.00000000');
      expect(infoBefore.balances.confirmed).to.equal('0.00000000');

      const block1 = makeBlock(1, block0.hash, [makeCoinbaseTx(2), spendTx]);
      addBlockToState(state, block1);
      clearMempool(state);

      await waitForHeight(tracker, 1);
      // updateMempool() must run again after the block is applied, otherwise
      // the now-mined tx's stale mempool entry keeps counting as pending.
      await tracker.updateMempool();

      const infoAfter = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(infoAfter.balances.confirmed).to.equal('10.00000000');
      expect(infoAfter.balances.pending).to.equal('0.00000000');

      const info0 = await tracker.getBalanceInfo(TEST_KEYS[0].address);
      expect(info0.balances.confirmed).to.equal('39.99000000');
      expect(info0.balances.pending).to.equal('0.00000000');
    });
  });

  describe('C3: mempool transaction eviction', function () {
    it('restores original balance when mempool tx disappears', async function () {
      const cb = makeCoinbaseTx(0, 50 * SATOSHI);
      const block0 = makeBlock(0, '0'.repeat(64), [cb]);
      const state = stubBlockchain(tracker, [block0]);

      tracker.start();
      await waitForSynced(tracker);

      const mempoolTx = makeTx({
        ins: [makeSpendInput(cb._txid, 0)],
        outs: [makeOutput(1, 10 * SATOSHI)]
      });
      addMempoolTx(state, mempoolTx);
      await tracker.updateMempool();

      const infoPending = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(infoPending.balances.pending).to.equal('10.00000000');

      clearMempool(state);
      await tracker.updateMempool();

      const info0 = await tracker.getBalanceInfo(TEST_KEYS[0].address);
      expect(info0.balances.confirmed).to.equal('50.00000000');
      expect(info0.balances.pending).to.equal('0.00000000');

      const info1 = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(info1.balances.pending).to.equal('0.00000000');
      expect(info1.balances.confirmed).to.equal('0.00000000');
    });
  });

  describe('C4: multiple mempool transactions', function () {
    it('tracks pending from multiple unconfirmed txs to different addresses', async function () {
      const cb0 = makeCoinbaseTx(0, 20 * SATOSHI);
      const cb1 = makeCoinbaseTx(0, 30 * SATOSHI);
      const block0 = makeBlock(0, '0'.repeat(64), [cb0]);
      const block1 = makeBlock(1, block0.hash, [cb1]);
      const state = stubBlockchain(tracker, [block0, block1]);

      tracker.start();
      await waitForSynced(tracker);

      const mpTx1 = makeTx({
        ins: [makeSpendInput(cb0._txid, 0)],
        outs: [makeOutput(1, 5 * SATOSHI)]
      });
      const mpTx2 = makeTx({
        ins: [makeSpendInput(cb1._txid, 0)],
        outs: [makeOutput(2, 8 * SATOSHI)]
      });

      addMempoolTx(state, mpTx1);
      addMempoolTx(state, mpTx2);
      await tracker.updateMempool();

      const info1 = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(info1.balances.pending).to.equal('5.00000000');

      const info2 = await tracker.getBalanceInfo(TEST_KEYS[2].address);
      expect(info2.balances.pending).to.equal('8.00000000');
    });
  });

  describe('C5: mempool output for new address', function () {
    it('shows pending balance for address with no confirmed history', async function () {
      const cb = makeCoinbaseTx(0, 50 * SATOSHI);
      const block0 = makeBlock(0, '0'.repeat(64), [cb]);
      const state = stubBlockchain(tracker, [block0]);

      tracker.start();
      await waitForSynced(tracker);

      const mempoolTx = makeTx({
        ins: [makeSpendInput(cb._txid, 0)],
        outs: [makeOutput(3, 7 * SATOSHI)]
      });
      addMempoolTx(state, mempoolTx);
      await tracker.updateMempool();

      const info3 = await tracker.getBalanceInfo(TEST_KEYS[3].address);
      expect(info3.balances.confirmed).to.equal('0.00000000');
      expect(info3.balances.pending).to.equal('7.00000000');
      expect(info3.utxos.confirmed).to.equal(0);
      expect(info3.utxos.pending).to.equal(1);

      const utxos3 = await tracker.getUtxosAddress(TEST_KEYS[3].address);
      expect(utxos3).to.have.length(1);
      expect(utxos3[0].confirmations).to.equal(0);
      expect(utxos3[0].amount).to.equal(7);
    });
  });
});
