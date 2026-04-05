'use strict';

const { expect } = require('chai');
const {
  SATOSHI, TEST_KEYS,
  makeOutput, makeSpendInput, makeTx, makeCoinbaseTx,
  makeBlock, processAndCommit, processBlocksAndCommit,
  createTestTracker, closeTracker
} = require('./helpers');

describe('Integration: Mempool', function () {
  let tracker;

  beforeEach(async function () {
    tracker = await createTestTracker();
  });

  afterEach(async function () {
    await closeTracker(tracker);
  });

  // Helper: parse a transaction into the mempool DB (mimics updateMempool logic)
  async function addToMempool(tx) {
    await tracker.mempoolDb.beginTransaction();
    await tracker.parseTransaction(tracker.mempoolDb, tx, null, -1, true);
    await tracker.mempoolDb.endTransaction();
  }

  // Helper: reset the mempool DB to empty (simulates mempool update that clears stale txs)
  async function resetMempool() {
    await tracker.mempoolDb.close();
    const LevelUpStore = require('../../src/LevelUpDb');
    tracker.mempoolDb = new LevelUpStore('mempool-reset-' + Date.now() + '-' + Math.random(), true);
    await tracker.mempoolDb.createDatabase();
  }

  // ─── Scenario 3.1: Mempool outputs appear as pending ──────────���───────

  describe('mempool outputs appear as pending', function () {
    it('shows unconfirmed outputs in pending balance', async function () {
      // Confirm 50 BTC to address 0
      const coinbaseTx = makeCoinbaseTx(0, 50 * SATOSHI);
      const block0 = makeBlock(0, '0'.repeat(64), [coinbaseTx]);
      await processAndCommit(tracker, block0);

      // Mempool: addr0 sends 10 BTC to addr1, 39.99 change
      const mempoolTx = makeTx({
        ins: [makeSpendInput(coinbaseTx._txid, 0)],
        outs: [
          makeOutput(1, 10 * SATOSHI),
          makeOutput(0, 3999000000)
        ]
      });
      await addToMempool(mempoolTx);

      // Address 1: has pending balance from mempool
      const info1 = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(info1.balances.confirmed).to.equal('0.00000000');
      expect(info1.balances.pending).to.equal('10.00000000');
      expect(info1.utxos.pending).to.equal(1);

      // Address 0: mempool change appears as pending
      const info0 = await tracker.getBalanceInfo(TEST_KEYS[0].address);
      expect(info0.balances.confirmed).to.equal('50.00000000');
      expect(parseFloat(info0.balances.pending)).to.be.greaterThan(0); // mempool change output
    });
  });

  // ─── Scenario 3.2: Mempool transaction gets confirmed ─────────────���───

  describe('mempool transaction gets confirmed', function () {
    it('moves balance from pending to confirmed', async function () {
      // Confirm 50 BTC to address 0
      const coinbaseTx = makeCoinbaseTx(0, 50 * SATOSHI);
      const block0 = makeBlock(0, '0'.repeat(64), [coinbaseTx]);
      await processAndCommit(tracker, block0);

      // Add to mempool
      const spendTx = makeTx({
        ins: [makeSpendInput(coinbaseTx._txid, 0)],
        outs: [makeOutput(1, 10 * SATOSHI), makeOutput(0, 3999000000)]
      });
      await addToMempool(spendTx);

      // Verify pending state for addr1
      const infoBefore = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(infoBefore.balances.pending).to.equal('10.00000000');

      // Now confirm the transaction in a block and reset mempool
      const block1 = makeBlock(1, block0.hash, [makeCoinbaseTx(2), spendTx]);
      await processAndCommit(tracker, block1);
      await resetMempool();

      // Address 1: now confirmed
      const infoAfter = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(infoAfter.balances.confirmed).to.equal('10.00000000');
      expect(infoAfter.balances.pending).to.equal('0.00000000');

      // Address 0: confirmed change only
      const info0 = await tracker.getBalanceInfo(TEST_KEYS[0].address);
      expect(info0.balances.confirmed).to.equal('39.99000000');
      expect(info0.balances.pending).to.equal('0.00000000');
    });
  });

  // ─── Scenario 3.3: Mempool transaction dropped ────────────────────────

  describe('mempool transaction dropped', function () {
    it('restores original balance when mempool tx disappears', async function () {
      // Confirm 50 BTC to address 0
      const coinbaseTx = makeCoinbaseTx(0, 50 * SATOSHI);
      const block0 = makeBlock(0, '0'.repeat(64), [coinbaseTx]);
      await processAndCommit(tracker, block0);

      // Add tx to mempool
      const mempoolTx = makeTx({
        ins: [makeSpendInput(coinbaseTx._txid, 0)],
        outs: [makeOutput(1, 10 * SATOSHI)]
      });
      await addToMempool(mempoolTx);

      // Verify addr1 has pending
      const infoPending = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(infoPending.balances.pending).to.equal('10.00000000');

      // Simulate dropped: clear entire mempool
      await resetMempool();

      // Address 0: back to full confirmed balance, no pending
      const info0 = await tracker.getBalanceInfo(TEST_KEYS[0].address);
      expect(info0.balances.confirmed).to.equal('50.00000000');
      expect(info0.balances.pending).to.equal('0.00000000');

      // Address 1: no more pending
      const info1 = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(info1.balances.confirmed).to.equal('0.00000000');
      expect(info1.balances.pending).to.equal('0.00000000');
    });
  });

  // ─── Scenario 3.4: Multiple mempool transactions ──────────────────────

  describe('multiple mempool transactions', function () {
    it('tracks pending from multiple unconfirmed txs to different addresses', async function () {
      // Two confirmed UTXOs to address 0
      const cb0 = makeCoinbaseTx(0, 20 * SATOSHI);
      const cb1 = makeCoinbaseTx(0, 30 * SATOSHI);
      const block0 = makeBlock(0, '0'.repeat(64), [cb0]);
      const block1 = makeBlock(1, block0.hash, [cb1]);
      await processBlocksAndCommit(tracker, [block0, block1]);

      // Two mempool txs spending different UTXOs
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

      // Address 1 and 2 have pending outputs
      const info1 = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(info1.balances.pending).to.equal('5.00000000');

      const info2 = await tracker.getBalanceInfo(TEST_KEYS[2].address);
      expect(info2.balances.pending).to.equal('8.00000000');
    });
  });

  // ─── Scenario 3.5: Mempool output for new address ─────────────────────

  describe('mempool output for new address', function () {
    it('shows pending balance for address with no confirmed history', async function () {
      // No confirmed outputs for addr3
      const coinbaseTx = makeCoinbaseTx(0, 50 * SATOSHI);
      const block0 = makeBlock(0, '0'.repeat(64), [coinbaseTx]);
      await processAndCommit(tracker, block0);

      // Mempool sends to addr3
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

      // getUtxosAddress should include the mempool UTXO
      const utxos3 = await tracker.getUtxosAddress(TEST_KEYS[3].address);
      expect(utxos3).to.have.length(1);
      expect(utxos3[0].confirmations).to.equal(0);
      expect(utxos3[0].amount).to.equal(7);
    });
  });
});
