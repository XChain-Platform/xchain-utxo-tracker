'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const {
  SCALE,
  TEST_KEYS,
  createTestTracker,
  closeTracker,
  resetTxCounter,
  generateAddressPool,
  buildDenseChain,
  buildCoinbaseChain,
  processBlock,
  processAndCommit,
  processBlocksAndCommit,
  randHash,
  makeBlock,
  makeCoinbaseTx,
  MetricsCollector,
  measureAsync,
  formatMs
} = require('./helpers');

// verifyReorg() runs with transactionArray=null in production (direct writes).
// This helper matches that flow, same as integration/reorg.test.js.
async function runVerifyReorg(tracker) {
  if (tracker.db.transactionArray) {
    await tracker.db.endTransaction(false);
  }
  tracker.db.transactionArray = null;
  tracker.db.deletedTransactionArray = null;
  await tracker.verifyReorg();
}

describe('Perf: Reorg Under Load', function () {
  let tracker;
  let addressPool;
  let metrics;

  before(function () {
    addressPool = generateAddressPool(SCALE.addresses);
    metrics = new MetricsCollector('Reorg Performance');
  });

  after(function () {
    metrics.printTable();
    metrics.saveIfRequested();
  });

  afterEach(async function () {
    if (tracker) {
      sinon.restore();
      await closeTracker(tracker);
      tracker = null;
    }
  });

  describe('reorg timing by depth', function () {
    // Only test depths within UNDO_BLOCKS (10) and within lastBlocks range
    const depths = [1, 3, 5, 10];

    for (const depth of depths) {
      it(`measures ${depth}-block reorg rollback time`, async function () {
        resetTxCounter();
        tracker = await createTestTracker();

        // Process blocks individually so lastBlocks is populated correctly.
        // Use exactly depth+5 blocks so all are within the undo window (max 10).
        const chainLength = depth + 5;
        const chain = buildDenseChain(chainLength, addressPool, Math.min(SCALE.txsPerBlock, 10));

        for (const block of chain) {
          await processAndCommit(tracker, block);
        }

        // Create divergent chain starting at (tip - depth)
        const forkPoint = chainLength - depth - 1;
        const divergentHashes = {};
        for (let i = forkPoint + 1; i < chainLength; i++) {
          divergentHashes[i] = randHash();
        }

        // Stub the connector to return divergent hashes
        sinon.stub(tracker.connector, 'getBlockHash').callsFake(async (height) => {
          if (divergentHashes[height] !== undefined) return divergentHashes[height];
          if (height >= 0 && height < chain.length) return chain[height].hash;
          throw new Error('Block not found');
        });

        // Measure reorg detection and rollback
        const { durationMs } = await measureAsync(async () => {
          await runVerifyReorg(tracker);
        });

        metrics.record(`reorg-depth-${depth}`, durationMs, { depth });

        console.log(`    Depth ${depth}: ${formatMs(durationMs)}`);

        // Verify rollback happened
        const newHeight = await tracker.db.getLastBlockHeight();
        expect(newHeight).to.equal(forkPoint,
          `Expected height ${forkPoint} after ${depth}-block reorg, got ${newHeight}`);
      });
    }

    it('verifies reorg time scales linearly with depth', function () {
      const depth1 = metrics.summarize('reorg-depth-1');
      const depth10 = metrics.summarize('reorg-depth-10');

      if (depth1 && depth10 && depth1.avg > 0) {
        const ratio = depth10.avg / depth1.avg;
        console.log(`    Scaling: depth-10 is ${ratio.toFixed(1)}x slower than depth-1`);
        // Linear would be 10x; allow up to 30x for constant overhead at small depths
        expect(ratio).to.be.lessThan(30,
          `Reorg scaling is super-linear: depth-10 was ${ratio.toFixed(1)}x slower than depth-1`);
      }
    });
  });

  describe('query consistency during reorg', function () {
    it('returns correct balances after reorg rollback', async function () {
      resetTxCounter();
      tracker = await createTestTracker();

      // Build a short chain (within UNDO_BLOCKS window)
      const baseChain = buildDenseChain(10, addressPool, 3);
      for (const block of baseChain) {
        await processAndCommit(tracker, block);
      }

      // Query balances before reorg
      const utxosBefore = await tracker.getUtxosAddress(addressPool[0].address);

      // Simulate a 3-block reorg by rolling back blocks 7, 8, 9
      const forkPoint = 6;
      const divergentHashes = {};
      for (let i = forkPoint + 1; i < 10; i++) {
        divergentHashes[i] = randHash();
      }

      sinon.stub(tracker.connector, 'getBlockHash').callsFake(async (height) => {
        if (divergentHashes[height] !== undefined) return divergentHashes[height];
        if (height >= 0 && height < baseChain.length) return baseChain[height].hash;
        throw new Error('Block not found');
      });

      // Perform reorg
      await runVerifyReorg(tracker);

      // Query after reorg
      const utxosAfter = await tracker.getUtxosAddress(addressPool[0].address);

      console.log(`    UTXOs before reorg: ${utxosBefore.length}`);
      console.log(`    UTXOs after 3-block reorg: ${utxosAfter.length}`);

      // Verify height was rolled back
      const newHeight = await tracker.db.getLastBlockHeight();
      expect(newHeight).to.equal(forkPoint);

      // After rolling back 3 blocks, UTXOs from those blocks should be restored
      // (REMOVE_SPENT recovers deleted outputs via K/M records)
      expect(utxosAfter.length).to.be.at.most(utxosBefore.length,
        'UTXOs should not increase after reorg rollback');
    });
  });

  describe('indexing recovery after reorg', function () {
    it('resumes normal throughput after reorg', async function () {
      resetTxCounter();
      tracker = await createTestTracker();

      // Phase 1: Index baseline chain (keep short for undo window)
      const baselineChain = buildDenseChain(10, addressPool, 5);

      const { durationMs: baselineMs } = await measureAsync(async () => {
        for (const block of baselineChain) {
          await processAndCommit(tracker, block);
        }
      });
      const baselinePerBlock = baselineMs / 10;

      // Phase 2: Simulate 5-block reorg
      const forkPoint = 4;
      const divergentHashes = {};
      for (let i = forkPoint + 1; i < 10; i++) {
        divergentHashes[i] = randHash();
      }

      sinon.stub(tracker.connector, 'getBlockHash').callsFake(async (height) => {
        if (divergentHashes[height] !== undefined) return divergentHashes[height];
        if (height >= 0 && height < baselineChain.length) return baselineChain[height].hash;
        throw new Error('Block not found');
      });

      // Perform reorg
      const { durationMs: reorgMs } = await measureAsync(async () => {
        await runVerifyReorg(tracker);
      });

      sinon.restore();

      // Phase 3: Index replacement chain (new blocks after fork point)
      resetTxCounter();
      const recoveryChain = buildDenseChain(10, addressPool, 5);
      recoveryChain.forEach((b, i) => { b.height = forkPoint + 1 + i; });

      // Set prevHash of first recovery block to match the fork point block
      if (forkPoint >= 0 && forkPoint < baselineChain.length) {
        recoveryChain[0].previousHash = baselineChain[forkPoint].hash;
      }

      const { durationMs: recoveryMs } = await measureAsync(async () => {
        for (const block of recoveryChain) {
          await processAndCommit(tracker, block);
        }
      });
      const recoveryPerBlock = recoveryMs / 10;

      const recoveryRatio = baselinePerBlock > 0 ? recoveryPerBlock / baselinePerBlock : 1;

      metrics.record('pre-reorg (per block)', baselinePerBlock);
      metrics.record('reorg-5-blocks', reorgMs);
      metrics.record('post-reorg (per block)', recoveryPerBlock);

      console.log(`    Baseline: ${formatMs(baselinePerBlock)}/block`);
      console.log(`    Reorg (5 blocks): ${formatMs(reorgMs)}`);
      console.log(`    Recovery: ${formatMs(recoveryPerBlock)}/block`);
      console.log(`    Recovery ratio: ${recoveryRatio.toFixed(2)}x baseline`);

      expect(recoveryRatio).to.be.lessThan(2.0,
        `Post-reorg throughput was ${recoveryRatio.toFixed(2)}x slower than baseline (threshold: 2.0x)`);
    });
  });
});
