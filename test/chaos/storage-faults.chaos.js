'use strict';

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

  // ════════════════════════════════��══════════════════════════════════════════
  // Experiment 1: LevelDB Batch Write Failure (LDB-01)
  // ═══════════════════════════════════════════════════��═══════════════════════

  describe('Exp 1: Batch Write Failure', function () {

    it('endTransaction throws without advancing LAST_BLOCK_HEIGHT', async function () {
      // Establish baseline: 3 committed blocks
      const blocks = await buildCommittedChain(tracker, 3);
      const heightBefore = await tracker.db.getLastBlockHeight();
      expect(heightBefore).to.equal(2);

      // Inject fault: batch writes will fail
      const fault = injectBatchWriteFailure(tracker.db, new Error('DISK_WRITE_ERR'));

      // Process 2 more blocks into a new batch (in-memory only)
      await tracker.db.beginTransaction();
      const block3 = makeBlock(3, blocks[2].hash, [makeCoinbaseTx(1)]);
      const block4 = makeBlock(4, block3.hash, [makeCoinbaseTx(1)]);
      await processBlock(tracker, block3);
      await processBlock(tracker, block4);

      // Commit should fail
      let threw = false;
      try {
        await tracker.db.endTransaction();
      } catch (err) {
        threw = true;
        expect(err.message).to.include('Error in LevelDB batch inserting');
      }
      expect(threw).to.be.true;

      // State anchor unchanged — atomicity preserved
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

      // First attempt fails
      try { await tracker.db.endTransaction(); } catch (e) { /* expected */ }

      // Restore and retry — the accumulated ops in transactionArray are still valid
      fault.restore();
      await tracker.db.endTransaction();

      // Block 3 is now committed
      expect(await tracker.db.getLastBlockHeight()).to.equal(3);
      expect(await tracker.db.getLastBlockHash()).to.equal(block3.hash);
    });

    it('balance queries return pre-fault state during failed batch', async function () {
      // Block 0: coinbase 50 BTC to addr 0
      const blocks = await buildCommittedChain(tracker, 1, 0);

      const infoBefore = await tracker.getBalanceInfo(TEST_KEYS[0].address);
      expect(infoBefore.balances.confirmed).to.equal('50.00000000');

      // Inject fault and try to commit more blocks
      const fault = injectBatchWriteFailure(tracker.db, new Error('DISK_WRITE_ERR'));

      await tracker.db.beginTransaction();
      const block1 = makeBlock(1, blocks[0].hash, [makeCoinbaseTx(1, 25 * SATOSHI)]);
      await processBlock(tracker, block1);

      try { await tracker.db.endTransaction(); } catch (e) { /* expected */ }

      // Balance query still returns pre-fault data
      const infoAfter = await tracker.getBalanceInfo(TEST_KEYS[0].address);
      expect(infoAfter.balances.confirmed).to.equal('50.00000000');

      // addr 1 has nothing (block1 never committed)
      const info1 = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(info1.balances.confirmed).to.equal('0.00000000');

      fault.restore();
    });
  });

  // ═════���════════════════════════════════════��══════════════════════════���═════
  // Experiment 9: Disk Full During Write (LDB-05)
  // ════════════��════════════════════════════��═════════════════════════════════

  describe('Exp 9: Disk Full During Write', function () {

    it('ENOSPC error preserves state and allows retry after space freed', async function () {
      const blocks = await buildCommittedChain(tracker, 3);
      const heightBefore = await tracker.db.getLastBlockHeight();

      // Inject disk-full error
      const enospc = new Error('ENOSPC: no space left on device, write');
      enospc.code = 'ENOSPC';
      const fault = injectBatchWriteFailure(tracker.db, enospc);

      await tracker.db.beginTransaction();
      const block3 = makeBlock(3, blocks[2].hash, [makeCoinbaseTx(0)]);
      const block4 = makeBlock(4, block3.hash, [makeCoinbaseTx(0)]);
      await processBlock(tracker, block3);
      await processBlock(tracker, block4);

      // Commit fails with disk-full
      let threw = false;
      try {
        await tracker.db.endTransaction();
      } catch (err) {
        threw = true;
      }
      expect(threw).to.be.true;

      // State unchanged
      expect(await tracker.db.getLastBlockHeight()).to.equal(heightBefore);

      // "Free disk space" and retry
      fault.restore();
      await tracker.db.endTransaction();

      // Blocks now committed
      expect(await tracker.db.getLastBlockHeight()).to.equal(4);

      // Balance reflects both new coinbases
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

      // All pre-existing data is intact and queryable
      for (let i = 0; i < 5; i++) {
        const block = await tracker.db.getBlock(blocks[i].hash);
        expect(block, `block ${i}`).to.not.be.null;
        expect(block.h).to.equal(i);
      }

      expect(await tracker.db.getLastBlockHeight()).to.equal(4);
    });
  });

  // ══════════════════���═══════════════════════════════════════���════════════════
  // Experiment 7: Process Crash Mid-Batch (STATE-04)
  // ═══════════��════════════════════════════════��══════════════════════════════

  describe('Exp 7: Process Crash Mid-Batch', function () {

    it('simulated crash loses uncommitted blocks, DB state intact', async function () {
      // Commit 3 blocks
      const blocks = await buildCommittedChain(tracker, 3, 0);
      const heightBefore = await tracker.db.getLastBlockHeight();
      expect(heightBefore).to.equal(2);

      // Start new batch, process 2 blocks (in-memory only)
      await tracker.db.beginTransaction();
      const block3 = makeBlock(3, blocks[2].hash, [makeCoinbaseTx(1)]);
      const block4 = makeBlock(4, block3.hash, [makeCoinbaseTx(1)]);
      await processBlock(tracker, block3);
      await processBlock(tracker, block4);

      // Simulate crash: forcibly discard in-memory state
      tracker.db.transactionArray = null;
      tracker.db.deletedTransactionArray = null;

      // DB still reflects last committed state
      expect(await tracker.db.getLastBlockHeight()).to.equal(heightBefore);
      expect(await tracker.db.getLastBlockHash()).to.equal(blocks[2].hash);

      // Blocks 3 and 4 are not in the DB
      expect(await tracker.db.getBlock(block3.hash)).to.be.null;
      expect(await tracker.db.getBlock(block4.hash)).to.be.null;
    });

    it('recovery after crash: re-process and commit succeeds', async function () {
      const blocks = await buildCommittedChain(tracker, 3, 0);

      // Start batch, process block 3, simulate crash
      await tracker.db.beginTransaction();
      const block3 = makeBlock(3, blocks[2].hash, [makeCoinbaseTx(1, 25 * SATOSHI)]);
      await processBlock(tracker, block3);

      // Crash
      tracker.db.transactionArray = null;
      tracker.db.deletedTransactionArray = null;

      // Recovery: start fresh and re-process
      await processAndCommit(tracker, block3);

      expect(await tracker.db.getLastBlockHeight()).to.equal(3);
      expect(await tracker.db.getLastBlockHash()).to.equal(block3.hash);

      const info = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(info.balances.confirmed).to.equal('25.00000000');
    });

    it('multiple crashes in sequence do not corrupt state', async function () {
      const blocks = await buildCommittedChain(tracker, 2, 0);

      // Crash 1
      await tracker.db.beginTransaction();
      await processBlock(tracker, makeBlock(2, blocks[1].hash, [makeCoinbaseTx(1)]));
      tracker.db.transactionArray = null;
      tracker.db.deletedTransactionArray = null;

      expect(await tracker.db.getLastBlockHeight()).to.equal(1);

      // Crash 2
      await tracker.db.beginTransaction();
      await processBlock(tracker, makeBlock(2, blocks[1].hash, [makeCoinbaseTx(2)]));
      tracker.db.transactionArray = null;
      tracker.db.deletedTransactionArray = null;

      expect(await tracker.db.getLastBlockHeight()).to.equal(1);

      // Finally succeed
      const block2 = makeBlock(2, blocks[1].hash, [makeCoinbaseTx(3, 10 * SATOSHI)]);
      await processAndCommit(tracker, block2);

      expect(await tracker.db.getLastBlockHeight()).to.equal(2);
      const info = await tracker.getBalanceInfo(TEST_KEYS[3].address);
      expect(info.balances.confirmed).to.equal('10.00000000');
    });
  });

  // ═���═════════════════════════════════════════════════════���═══════════════════
  // Experiment 2: LevelDB Read Latency (LDB-03)
  // ══════════��══════════════════════════════���══════════════════════════════���══

  describe('Exp 2: Read Latency Injection', function () {

    it('balance query returns correct results despite latency', async function () {
      await buildCommittedChain(tracker, 5, 0);

      // Baseline query
      const baseline = await tracker.getBalanceInfo(TEST_KEYS[0].address);
      expect(baseline.balances.confirmed).to.equal('250.00000000');

      // Inject 5ms latency per read
      const fault = injectReadLatency(tracker.db, 5);

      const delayed = await tracker.getBalanceInfo(TEST_KEYS[0].address);
      expect(delayed.balances.confirmed).to.equal('250.00000000');

      fault.restore();
    });

    it('latency injection measurably slows queries', async function () {
      await buildCommittedChain(tracker, 5, 0);

      // Warm up to stabilize JIT (first call is always slow)
      await tracker.getBalanceInfo(TEST_KEYS[0].address);

      // Measure baseline (average of 3 runs)
      let baselineTotal = 0;
      for (let i = 0; i < 3; i++) {
        const { ms } = await measureMs(
          () => tracker.getBalanceInfo(TEST_KEYS[0].address)
        );
        baselineTotal += ms;
      }
      const baselineMs = baselineTotal / 3;

      // Inject 50ms latency per read operation (get + iterator)
      const fault = injectReadLatency(tracker.db, 50);

      const { ms: delayedMs } = await measureMs(
        () => tracker.getBalanceInfo(TEST_KEYS[0].address)
      );

      fault.restore();

      // Delayed query should be at least 50ms slower than baseline
      // (at minimum one iterator scan is delayed by 50ms)
      expect(delayedMs).to.be.greaterThan(baselineMs + 30);
    });

    it('latency returns to baseline after fault restore', async function () {
      await buildCommittedChain(tracker, 3, 0);

      // Baseline
      const { ms: before } = await measureMs(
        () => tracker.getBalanceInfo(TEST_KEYS[0].address)
      );

      // Inject and restore
      const fault = injectReadLatency(tracker.db, 20);
      fault.restore();

      // Post-restore should be similar to baseline
      const { ms: after } = await measureMs(
        () => tracker.getBalanceInfo(TEST_KEYS[0].address)
      );

      // Allow generous margin but ensure no lingering delay
      expect(after).to.be.lessThan(before + 50);
    });
  });
});
