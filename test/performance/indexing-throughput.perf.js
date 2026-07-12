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
  SCALE,
  createTestTracker,
  closeTracker,
  resetTxCounter,
  generateAddressPool,
  buildDenseChain,
  buildSpendingChain,
  extractUtxoPool,
  processBlocksAndCommit,
  processAndCommit,
  MetricsCollector,
  measureAsync,
  formatRate,
  formatMs
} = require('./helpers');

describe('Perf: Sustained Indexing Throughput', function () {
  let tracker;
  let addressPool;
  let metrics;

  before(async function () {
    resetTxCounter();
    tracker = await createTestTracker();
    addressPool = generateAddressPool(SCALE.addresses);
    metrics = new MetricsCollector('Sustained Indexing');
  });

  after(async function () {
    metrics.printTable();
    metrics.saveIfRequested();
    await closeTracker(tracker);
  });

  it('processes blocks in 100-block batches and reports throughput', async function () {
    const chain = buildDenseChain(SCALE.blocks, addressPool, SCALE.txsPerBlock);
    const batchSize = 100;
    const totalTxs = SCALE.blocks * SCALE.txsPerBlock;

    const { durationMs: totalMs } = await measureAsync(async () => {
      for (let i = 0; i < chain.length; i += batchSize) {
        const batch = chain.slice(i, i + batchSize);
        const { durationMs: batchMs } = await measureAsync(async () => {
          await processBlocksAndCommit(tracker, batch);
        });
        metrics.record('batch-commit (100 blocks)', batchMs, {
          blocks: batch.length,
          txs: batch.length * SCALE.txsPerBlock
        });
      }
    });

    metrics.record('full-indexing', totalMs, {
      totalBlocks: SCALE.blocks,
      totalTxs
    });

    const blocksPerSec = (SCALE.blocks / totalMs) * 1000;
    const txsPerSec = (totalTxs / totalMs) * 1000;

    console.log(`    Total: ${SCALE.blocks} blocks, ${totalTxs} txs in ${formatMs(totalMs)}`);
    console.log(`    Throughput: ${formatRate(SCALE.blocks, totalMs)} blocks, ${formatRate(totalTxs, totalMs)} txs`);

    expect(blocksPerSec).to.be.greaterThan(0, 'Should process blocks');
    expect(txsPerSec).to.be.greaterThan(0, 'Should process transactions');
  });

  it('detects throughput degradation between first and second half', async function () {
    await closeTracker(tracker);
    tracker = await createTestTracker();
    resetTxCounter();

    const chain = buildDenseChain(SCALE.blocks, addressPool, SCALE.txsPerBlock);
    const mid = Math.floor(chain.length / 2);
    const batchSize = 100;

    // Per-batch timings, compared by median: a whole-half wall-clock ratio is
    // one sample per side, so a single GC pause or LevelDB compaction in either
    // half swings it across the threshold on shared runners. The median batch
    // time still degrades if indexing genuinely slows with database size.
    async function timeBatches(start, end) {
      const times = [];
      for (let i = start; i < end; i += batchSize) {
        const batch = chain.slice(i, Math.min(i + batchSize, end));
        const { durationMs } = await measureAsync(() => processBlocksAndCommit(tracker, batch));
        times.push(durationMs);
      }
      const sorted = times.slice().sort((a, b) => a - b);
      return {
        totalMs:  times.reduce((a, b) => a + b, 0),
        medianMs: sorted[Math.floor(sorted.length / 2)]
      };
    }

    const first  = await timeBatches(0, mid);
    const second = await timeBatches(mid, chain.length);
    const firstHalfMs  = first.totalMs;
    const secondHalfMs = second.totalMs;

    const ratio = second.medianMs / first.medianMs;

    metrics.record('first-half', firstHalfMs);
    metrics.record('second-half', secondHalfMs);

    console.log(`    First half:  ${formatMs(firstHalfMs)} (median batch ${formatMs(first.medianMs)})`);
    console.log(`    Second half: ${formatMs(secondHalfMs)} (median batch ${formatMs(second.medianMs)})`);
    console.log(`    Degradation ratio (median batch): ${ratio.toFixed(2)}x`);

    expect(ratio).to.be.lessThan(2.0,
      `Second-half median batch was ${ratio.toFixed(2)}x slower than first half (threshold: 2.0x)`);
  });

  it('does not leak memory during sustained indexing', async function () {
    await closeTracker(tracker);
    tracker = await createTestTracker();
    resetTxCounter();

    // Force GC if available
    if (global.gc) global.gc();
    const heapBefore = process.memoryUsage().heapUsed;

    const chain = buildDenseChain(SCALE.blocks, addressPool, SCALE.txsPerBlock);
    const batchSize = 100;

    for (let i = 0; i < chain.length; i += batchSize) {
      const batch = chain.slice(i, Math.min(i + batchSize, chain.length));
      await processBlocksAndCommit(tracker, batch);
    }

    if (global.gc) global.gc();
    const heapAfter = process.memoryUsage().heapUsed;
    const heapGrowthMB = (heapAfter - heapBefore) / (1024 * 1024);

    metrics.record('heap-growth-MB', heapGrowthMB);

    console.log(`    Heap before: ${(heapBefore / 1024 / 1024).toFixed(1)} MB`);
    console.log(`    Heap after:  ${(heapAfter / 1024 / 1024).toFixed(1)} MB`);
    console.log(`    Growth:      ${heapGrowthMB.toFixed(1)} MB`);

    // Allow generous threshold (memdown stores everything in memory,
    // so growth is expected; we're looking for leaks beyond the data itself
    const expectedDataMB = (SCALE.blocks * SCALE.txsPerBlock * 200) / (1024 * 1024); // ~200 bytes per UTXO entry
    const leakThreshold = expectedDataMB + 100; // data + 100MB overhead

    expect(heapGrowthMB).to.be.lessThan(leakThreshold,
      `Heap grew ${heapGrowthMB.toFixed(1)}MB, exceeding threshold of ${leakThreshold.toFixed(1)}MB`);
  });
});

describe('Perf: Spike Load', function () {
  let tracker;
  let addressPool;
  let metrics;

  before(async function () {
    resetTxCounter();
    tracker = await createTestTracker();
    addressPool = generateAddressPool(SCALE.addresses);
    metrics = new MetricsCollector('Spike Load');
  });

  after(async function () {
    metrics.printTable();
    metrics.saveIfRequested();
    await closeTracker(tracker);
  });

  it('handles spike blocks and recovers to baseline throughput', async function () {
    const baselineTxsPerBlock = 2;
    const spikeTxsPerBlock = SCALE.txsPerBlock * 5;
    const phaseBlocks = Math.max(20, Math.floor(SCALE.blocks / 5));

    // Per-block medians, not phase averages: small blocks index in well under a
    // millisecond, so one GC pause or compaction inside either phase swings a
    // single-sample average across the threshold on shared runners. A genuine
    // failure to recover still shifts the whole recovery distribution.
    async function medianPerBlock(blocks) {
      const times = [];
      for (const block of blocks) {
        const { durationMs } = await measureAsync(() => processAndCommit(tracker, block));
        times.push(durationMs);
      }
      const sorted = times.slice().sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length / 2)];
    }

    // Phase 1: Baseline (small blocks)
    const baselineChain = buildDenseChain(phaseBlocks, addressPool, baselineTxsPerBlock);
    const baselinePerBlock = await medianPerBlock(baselineChain);

    // Phase 2: Spike (large blocks)
    const spikeCount = Math.max(5, Math.floor(phaseBlocks / 4));
    const spikeChain = buildDenseChain(spikeCount, addressPool, spikeTxsPerBlock);
    // Adjust heights to continue from baseline
    spikeChain.forEach((b, i) => { b.height = phaseBlocks + i; });

    const spikeTimes = [];
    for (const block of spikeChain) {
      const { durationMs } = await measureAsync(async () => {
        await processAndCommit(tracker, block);
      });
      spikeTimes.push(durationMs);
      metrics.record('spike-block', durationMs, { txsPerBlock: spikeTxsPerBlock });
    }

    // Phase 3: Recovery (small blocks again)
    const recoveryChain = buildDenseChain(phaseBlocks, addressPool, baselineTxsPerBlock);
    recoveryChain.forEach((b, i) => { b.height = phaseBlocks + spikeCount + i; });

    const recoveryPerBlock = await medianPerBlock(recoveryChain);

    metrics.record('baseline-phase (per block)', baselinePerBlock);
    metrics.record('recovery-phase (per block)', recoveryPerBlock);

    const recoveryRatio = recoveryPerBlock / baselinePerBlock;

    console.log(`    Baseline: ${formatMs(baselinePerBlock)}/block (${baselineTxsPerBlock} txs)`);
    console.log(`    Spike avg: ${formatMs(spikeTimes.reduce((a, b) => a + b, 0) / spikeCount)}/block (${spikeTxsPerBlock} txs)`);
    console.log(`    Recovery: ${formatMs(recoveryPerBlock)}/block (${baselineTxsPerBlock} txs)`);
    console.log(`    Recovery ratio: ${recoveryRatio.toFixed(2)}x baseline`);

    expect(recoveryRatio).to.be.lessThan(1.5,
      `Recovery throughput was ${recoveryRatio.toFixed(2)}x slower than baseline (threshold: 1.5x)`);
  });

  it('spike block processing scales linearly with transaction count', async function () {
    await closeTracker(tracker);
    tracker = await createTestTracker();
    resetTxCounter();

    const txCounts = [2, 10, SCALE.txsPerBlock, SCALE.txsPerBlock * 3];
    const timings = [];

    for (const txCount of txCounts) {
      const chain = buildDenseChain(5, addressPool, txCount);
      const { durationMs } = await measureAsync(async () => {
        await processBlocksAndCommit(tracker, chain);
      });
      const perBlock = durationMs / 5;
      timings.push({ txCount, perBlock });
      metrics.record(`block-${txCount}txs`, perBlock);

      console.log(`    ${txCount} txs/block: ${formatMs(perBlock)}/block`);
    }

    // Check linearity: time should scale roughly proportional to tx count
    // Compare smallest vs largest
    if (timings.length >= 2 && timings[0].perBlock > 0) {
      const first = timings[0];
      const last = timings[timings.length - 1];
      const txRatio = last.txCount / first.txCount;
      const timeRatio = last.perBlock / first.perBlock;
      // Allow 3x the linear expectation (accounts for constant overhead)
      const linearityBound = txRatio * 3;

      console.log(`    Tx ratio: ${txRatio.toFixed(1)}x, Time ratio: ${timeRatio.toFixed(1)}x (linear bound: ${linearityBound.toFixed(1)}x)`);

      expect(timeRatio).to.be.lessThan(linearityBound,
        `Processing time grew ${timeRatio.toFixed(1)}x for ${txRatio.toFixed(1)}x more txs (super-linear)`);
    }
  });
});
