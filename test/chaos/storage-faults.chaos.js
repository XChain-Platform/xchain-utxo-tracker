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
  injectBatchWriteFailure, injectReadLatency, measureMs,
  buildCommittedChain
} = require('./chaos-helpers');

describe('Chaos: Storage Faults', function () {
  let tracker;

  beforeEach(async function () {
    tracker = await createTestTracker();
  });

  afterEach(async function () {
    sinon.restore();
    await closeTracker(tracker);
  });

  describe('Exp 1: Batch Write Failure', function () {

    it('endTransaction throws without advancing LAST_BLOCK_HEIGHT', async function () {
      const blocks = await buildCommittedChain(tracker, 3);
      const heightBefore = await tracker.db.getLastBlockHeight();
      expect(heightBefore).to.equal(2);

      const fault = injectBatchWriteFailure(tracker.db, new Error('DISK_WRITE_ERR'));

      // Batch is in-memory only until endTransaction commits it
      await tracker.db.beginTransaction();
      const block3 = makeBlock(3, blocks[2].hash, [makeCoinbaseTx(1)]);
      const block4 = makeBlock(4, block3.hash, [makeCoinbaseTx(1)]);
      await processBlock(tracker, block3);
      await processBlock(tracker, block4);

      let threw = false;
      try {
        await tracker.db.endTransaction();
      } catch (err) {
        threw = true;
        expect(err.message).to.include('Error in LevelDB batch inserting');
      }
      expect(threw).to.be.true;

      // State anchor unchanged: atomicity preserved
      expect(await tracker.db.getLastBlockHeight()).to.equal(heightBefore);

      // transactionArray preserved (Map not nullified on error)
      expect(tracker.db.transactionArray).to.be.an.instanceOf(Map);
      expect(tracker.db.transactionArray.size).to.be.greaterThan(0);

      fault.restore();
    });

    it('retrying endTransaction after fault restore succeeds', async function () {
      const blocks = await buildCommittedChain(tracker, 3);

      const fault = injectBatchWriteFailure(tracker.db, new Error('DISK_WRITE_ERR'));

      await tracker.db.beginTransaction();
      const block3 = makeBlock(3, blocks[2].hash, [makeCoinbaseTx(0)]);
      await processBlock(tracker, block3);

      try { await tracker.db.endTransaction(); } catch (e) { /* expected */ }

      // Retry succeeds because the accumulated ops in transactionArray are still valid
      fault.restore();
      await tracker.db.endTransaction();

      expect(await tracker.db.getLastBlockHeight()).to.equal(3);
      expect(await tracker.db.getLastBlockHash()).to.equal(block3.hash);
    });

    it('balance queries return pre-fault state during failed batch', async function () {
      const blocks = await buildCommittedChain(tracker, 1, 0);

      const infoBefore = await tracker.getBalanceInfo(TEST_KEYS[0].address);
      expect(infoBefore.balances.confirmed).to.equal('50.00000000');

      const fault = injectBatchWriteFailure(tracker.db, new Error('DISK_WRITE_ERR'));

      await tracker.db.beginTransaction();
      const block1 = makeBlock(1, blocks[0].hash, [makeCoinbaseTx(1, 25 * SATOSHI)]);
      await processBlock(tracker, block1);

      try { await tracker.db.endTransaction(); } catch (e) { /* expected */ }

      const infoAfter = await tracker.getBalanceInfo(TEST_KEYS[0].address);
      expect(infoAfter.balances.confirmed).to.equal('50.00000000');

      // addr 1 has nothing (block1 never committed)
      const info1 = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(info1.balances.confirmed).to.equal('0.00000000');

      fault.restore();
    });
  });

  describe('Exp 9: Disk Full During Write', function () {

    it('ENOSPC error preserves state and allows retry after space freed', async function () {
      const blocks = await buildCommittedChain(tracker, 3);
      const heightBefore = await tracker.db.getLastBlockHeight();

      const enospc = new Error('ENOSPC: no space left on device, write');
      enospc.code = 'ENOSPC';
      const fault = injectBatchWriteFailure(tracker.db, enospc);

      await tracker.db.beginTransaction();
      const block3 = makeBlock(3, blocks[2].hash, [makeCoinbaseTx(0)]);
      const block4 = makeBlock(4, block3.hash, [makeCoinbaseTx(0)]);
      await processBlock(tracker, block3);
      await processBlock(tracker, block4);

      let threw = false;
      try {
        await tracker.db.endTransaction();
      } catch (err) {
        threw = true;
      }
      expect(threw).to.be.true;

      expect(await tracker.db.getLastBlockHeight()).to.equal(heightBefore);

      fault.restore();
      await tracker.db.endTransaction();

      expect(await tracker.db.getLastBlockHeight()).to.equal(4);

      const info = await tracker.getBalanceInfo(TEST_KEYS[0].address);
      // 3 original blocks + 2 new blocks = 5 × 50 BTC = 250
      expect(info.balances.confirmed).to.equal('250.00000000');
    });

    it('existing data remains readable after disk-full error', async function () {
      const blocks = await buildCommittedChain(tracker, 5, 0);

      const enospc = new Error('ENOSPC: no space left on device');
      enospc.code = 'ENOSPC';
      const fault = injectBatchWriteFailure(tracker.db, enospc);

      await tracker.db.beginTransaction();
      await processBlock(tracker, makeBlock(5, blocks[4].hash, [makeCoinbaseTx(1)]));

      try { await tracker.db.endTransaction(); } catch (e) { /* expected */ }

      fault.restore();

      for (let i = 0; i < 5; i++) {
        const block = await tracker.db.getBlock(blocks[i].hash);
        expect(block, `block ${i}`).to.not.be.null;
        expect(block.h).to.equal(i);
      }

      expect(await tracker.db.getLastBlockHeight()).to.equal(4);
    });
  });

  describe('Exp 7: Process Crash Mid-Batch', function () {

    it('simulated crash loses uncommitted blocks, DB state intact', async function () {
      const blocks = await buildCommittedChain(tracker, 3, 0);
      const heightBefore = await tracker.db.getLastBlockHeight();
      expect(heightBefore).to.equal(2);

      // Batch is in-memory only until endTransaction commits it
      await tracker.db.beginTransaction();
      const block3 = makeBlock(3, blocks[2].hash, [makeCoinbaseTx(1)]);
      const block4 = makeBlock(4, block3.hash, [makeCoinbaseTx(1)]);
      await processBlock(tracker, block3);
      await processBlock(tracker, block4);

      // A crash loses the in-memory batch; simulate it by discarding directly
      tracker.db.transactionArray = null;
      tracker.db.deletedTransactionArray = null;

      expect(await tracker.db.getLastBlockHeight()).to.equal(heightBefore);
      expect(await tracker.db.getLastBlockHash()).to.equal(blocks[2].hash);

      expect(await tracker.db.getBlock(block3.hash)).to.be.null;
      expect(await tracker.db.getBlock(block4.hash)).to.be.null;
    });

    it('recovery after crash: re-process and commit succeeds', async function () {
      const blocks = await buildCommittedChain(tracker, 3, 0);

      await tracker.db.beginTransaction();
      const block3 = makeBlock(3, blocks[2].hash, [makeCoinbaseTx(1, 25 * SATOSHI)]);
      await processBlock(tracker, block3);

      tracker.db.transactionArray = null;
      tracker.db.deletedTransactionArray = null;

      await processAndCommit(tracker, block3);

      expect(await tracker.db.getLastBlockHeight()).to.equal(3);
      expect(await tracker.db.getLastBlockHash()).to.equal(block3.hash);

      const info = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(info.balances.confirmed).to.equal('25.00000000');
    });

    it('multiple crashes in sequence do not corrupt state', async function () {
      const blocks = await buildCommittedChain(tracker, 2, 0);

      await tracker.db.beginTransaction();
      await processBlock(tracker, makeBlock(2, blocks[1].hash, [makeCoinbaseTx(1)]));
      tracker.db.transactionArray = null;
      tracker.db.deletedTransactionArray = null;

      expect(await tracker.db.getLastBlockHeight()).to.equal(1);

      await tracker.db.beginTransaction();
      await processBlock(tracker, makeBlock(2, blocks[1].hash, [makeCoinbaseTx(2)]));
      tracker.db.transactionArray = null;
      tracker.db.deletedTransactionArray = null;

      expect(await tracker.db.getLastBlockHeight()).to.equal(1);

      const block2 = makeBlock(2, blocks[1].hash, [makeCoinbaseTx(3, 10 * SATOSHI)]);
      await processAndCommit(tracker, block2);

      expect(await tracker.db.getLastBlockHeight()).to.equal(2);
      const info = await tracker.getBalanceInfo(TEST_KEYS[3].address);
      expect(info.balances.confirmed).to.equal('10.00000000');
    });
  });

  describe('Exp 2: Read Latency Injection', function () {

    it('balance query returns correct results despite latency', async function () {
      await buildCommittedChain(tracker, 5, 0);

      const baseline = await tracker.getBalanceInfo(TEST_KEYS[0].address);
      expect(baseline.balances.confirmed).to.equal('250.00000000');

      const fault = injectReadLatency(tracker.db, 5);

      const delayed = await tracker.getBalanceInfo(TEST_KEYS[0].address);
      expect(delayed.balances.confirmed).to.equal('250.00000000');

      fault.restore();
    });

    it('latency injection measurably slows queries', async function () {
      await buildCommittedChain(tracker, 5, 0);

      // Warm up to stabilize JIT (first call is always slow)
      await tracker.getBalanceInfo(TEST_KEYS[0].address);

      let baselineTotal = 0;
      for (let i = 0; i < 3; i++) {
        const { ms } = await measureMs(
          () => tracker.getBalanceInfo(TEST_KEYS[0].address)
        );
        baselineTotal += ms;
      }
      const baselineMs = baselineTotal / 3;

      // 50ms latency applies to both get and iterator reads
      const fault = injectReadLatency(tracker.db, 50);

      const { ms: delayedMs } = await measureMs(
        () => tracker.getBalanceInfo(TEST_KEYS[0].address)
      );

      fault.restore();

      // Margin of 30ms (not the full 50ms) accounts for timer jitter while
      // still confirming at least one delayed read was on the query path.
      expect(delayedMs).to.be.greaterThan(baselineMs + 30);
    });

    it('latency returns to baseline after fault restore', async function () {
      await buildCommittedChain(tracker, 3, 0);

      const { ms: before } = await measureMs(
        () => tracker.getBalanceInfo(TEST_KEYS[0].address)
      );

      const fault = injectReadLatency(tracker.db, 20);
      fault.restore();

      const { ms: after } = await measureMs(
        () => tracker.getBalanceInfo(TEST_KEYS[0].address)
      );

      // Allow generous margin but ensure no lingering delay
      expect(after).to.be.lessThan(before + 50);
    });
  });
});
