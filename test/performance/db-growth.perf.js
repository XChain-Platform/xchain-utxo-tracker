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
  SCALE,
  createTestTracker,
  closeTracker,
  resetTxCounter,
  generateAddressPool,
  buildDenseChain,
  processBlocksAndCommit,
  MetricsCollector,
  measureAsync,
  formatMs,
  formatRate
} = require('./helpers');

describe('Perf: Database Growth Degradation', function () {
  let tracker;
  let addressPool;
  let metrics;

  before(async function () {
    resetTxCounter();
    tracker = await createTestTracker();
    addressPool = generateAddressPool(SCALE.addresses);
    metrics = new MetricsCollector('DB Growth');
  });

  after(async function () {
    metrics.printTable();
    metrics.saveIfRequested();
    await closeTracker(tracker);
  });

  it('measures query time degradation as database grows', async function () {
    // Build a large coinbase-only chain so UTXOs accumulate (no spending)
    const totalBlocks = SCALE.blocks;
    const chain = buildDenseChain(totalBlocks, addressPool, SCALE.txsPerBlock);
    const batchSize = 100;

    const checkpoints = [0.25, 0.50, 0.75, 1.00];
    const results = [];
    let blocksProcessed = 0;

    for (const pct of checkpoints) {
      const targetBlocks = Math.floor(totalBlocks * pct);
      const blocksToProcess = targetBlocks - blocksProcessed;

      if (blocksToProcess > 0) {
        // Index blocks up to this checkpoint
        for (let i = blocksProcessed; i < targetBlocks; i += batchSize) {
          const end = Math.min(i + batchSize, targetBlocks);
          const batch = chain.slice(i, end);
          await processBlocksAndCommit(tracker, batch);
        }
        blocksProcessed = targetBlocks;
      }

      // Count total UTXOs by querying all addresses
      let totalUtxos = 0;

      // Measure serial query time
      const sampleSize = Math.min(SCALE.addresses, 50);
      const sampleAddresses = addressPool.slice(0, sampleSize);

      const { durationMs: serialMs } = await measureAsync(async () => {
        for (const key of sampleAddresses) {
          const utxos = await tracker.getUtxosAddress(key.address);
          totalUtxos += utxos.length;
        }
      });

      // Measure concurrent query time
      const { durationMs: concurrentMs } = await measureAsync(async () => {
        await Promise.all(sampleAddresses.map(key =>
          tracker.getBalanceInfo(key.address)
        ));
      });

      const perQuerySerial = serialMs / sampleSize;
      const perQueryConcurrent = concurrentMs / sampleSize;

      results.push({
        pct,
        blocks: targetBlocks,
        utxos: totalUtxos,
        serialMs,
        concurrentMs,
        perQuerySerial,
        perQueryConcurrent
      });

      metrics.record(`query@${Math.round(pct * 100)}% (serial)`, perQuerySerial, {
        blocks: targetBlocks,
        utxos: totalUtxos
      });
      metrics.record(`query@${Math.round(pct * 100)}% (concurrent)`, perQueryConcurrent);
    }

    // Print degradation table
    console.log('\n    Database Growth Degradation Report:');
    console.log('    ' + '─'.repeat(80));
    console.log('    ' + pad('Checkpoint', 12) + pad('Blocks', 10) + pad('UTXOs', 10) +
      pad('Serial/q', 14) + pad('Concurrent/q', 14) + pad('Ratio', 10));
    console.log('    ' + '─'.repeat(80));

    for (const r of results) {
      const ratio = results[0].perQuerySerial > 0
        ? (r.perQuerySerial / results[0].perQuerySerial).toFixed(2) + 'x'
        : 'N/A';

      console.log('    ' + pad(`${Math.round(r.pct * 100)}%`, 12) +
        pad(r.blocks, 10) + pad(r.utxos, 10) +
        pad(formatMs(r.perQuerySerial), 14) +
        pad(formatMs(r.perQueryConcurrent), 14) +
        pad(ratio, 10));
    }
    console.log('    ' + '─'.repeat(80));

    // Assert sub-linear growth: 100% should be < 4x the 25% query time
    if (results.length >= 2 && results[0].perQuerySerial > 0) {
      const first = results[0];
      const last = results[results.length - 1];
      const degradationRatio = last.perQuerySerial / first.perQuerySerial;

      console.log(`\n    Overall degradation: ${degradationRatio.toFixed(2)}x (threshold: 4.0x)`);

      expect(degradationRatio).to.be.lessThan(4.0,
        `Query time at 100% was ${degradationRatio.toFixed(2)}x slower than at 25% (threshold: 4.0x)`);
    }
  });

  it('measures write throughput at different database sizes', async function () {
    await closeTracker(tracker);
    tracker = await createTestTracker();
    resetTxCounter();

    const totalBlocks = SCALE.blocks;
    const chain = buildDenseChain(totalBlocks, addressPool, SCALE.txsPerBlock);
    const batchSize = 100;
    const checkpoints = [0.25, 0.50, 0.75, 1.00];
    let blocksProcessed = 0;

    for (const pct of checkpoints) {
      const targetBlocks = Math.floor(totalBlocks * pct);
      const startBlock = blocksProcessed;
      const blocksToProcess = targetBlocks - startBlock;

      if (blocksToProcess <= 0) continue;

      const { durationMs } = await measureAsync(async () => {
        for (let i = startBlock; i < targetBlocks; i += batchSize) {
          const end = Math.min(i + batchSize, targetBlocks);
          const batch = chain.slice(i, end);
          await processBlocksAndCommit(tracker, batch);
        }
      });

      blocksProcessed = targetBlocks;
      const blocksPerSec = (blocksToProcess / durationMs) * 1000;
      const txsPerSec = (blocksToProcess * SCALE.txsPerBlock / durationMs) * 1000;

      metrics.record(`write@${Math.round(pct * 100)}%`, durationMs, {
        blocks: blocksToProcess,
        blocksPerSec,
        txsPerSec
      });

      console.log(`    Write @${Math.round(pct * 100)}%: ${blocksToProcess} blocks in ${formatMs(durationMs)} (${formatRate(blocksToProcess, durationMs)} blocks, ${formatRate(blocksToProcess * SCALE.txsPerBlock, durationMs)} txs)`);
    }
  });
});

function pad(str, len) {
  const s = String(str);
  return s.length >= len ? s : s + ' '.repeat(len - s.length);
}
