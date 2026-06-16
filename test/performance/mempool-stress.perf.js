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
  seedTracker,
  populateMempool,
  clearMempoolDb,
  MetricsCollector,
  measureAsync,
  formatMs,
  formatRate
} = require('./helpers');

describe('Perf: Mempool Stress', function () {
  let tracker;
  let addressPool;
  let utxoPool;
  let metrics;

  before(async function () {
    resetTxCounter();
    tracker = await createTestTracker();
    addressPool = generateAddressPool(SCALE.addresses);
    metrics = new MetricsCollector('Mempool Stress');

    // Seed confirmed chain — need enough UTXOs for mempool spending
    const seedBlocks = Math.max(100, Math.ceil(SCALE.mempoolTxs / SCALE.txsPerBlock) * 2);
    const result = await seedTracker(tracker, seedBlocks, addressPool, SCALE.txsPerBlock);
    utxoPool = result.utxoPool;
  });

  after(async function () {
    metrics.printTable();
    metrics.saveIfRequested();
    await closeTracker(tracker);
  });

  it('measures mempool population time', async function () {
    const { durationMs } = await measureAsync(async () => {
      await populateMempool(tracker, utxoPool, addressPool, SCALE.mempoolTxs);
    });

    metrics.record('mempool-populate', durationMs, {
      txCount: SCALE.mempoolTxs
    });

    console.log(`    Populated ${SCALE.mempoolTxs} mempool txs in ${formatMs(durationMs)}`);
    console.log(`    Rate: ${formatRate(SCALE.mempoolTxs, durationMs)}`);

    expect(durationMs).to.be.greaterThan(0);
  });

  it('measures balance query time with populated mempool', async function () {
    // Mempool should already be populated from previous test
    // Query a sample of addresses
    const sampleSize = Math.min(SCALE.addresses, 50);
    const queryAddresses = addressPool.slice(0, sampleSize);

    const { durationMs } = await measureAsync(async () => {
      for (const key of queryAddresses) {
        await tracker.getBalanceInfo(key.address);
      }
    });

    const perQuery = durationMs / sampleSize;

    metrics.record('balance-query-with-mempool', perQuery, {
      sampleSize,
      mempoolSize: SCALE.mempoolTxs
    });

    console.log(`    ${sampleSize} balance queries in ${formatMs(durationMs)}`);
    console.log(`    Average: ${formatMs(perQuery)}/query`);

    expect(perQuery).to.be.greaterThan(0);
  });

  it('measures mempool churn performance over 5 rounds', async function () {
    const roundTimes = [];

    for (let round = 0; round < 5; round++) {
      // Clear mempool
      await clearMempoolDb(tracker);

      // Use a different slice of UTXOs each round to avoid conflicts
      const offset = round * SCALE.mempoolTxs;
      const roundUtxos = utxoPool.slice(offset, offset + SCALE.mempoolTxs);
      const count = Math.min(SCALE.mempoolTxs, roundUtxos.length);

      if (count === 0) break;

      const { durationMs } = await measureAsync(async () => {
        await populateMempool(tracker, roundUtxos, addressPool, count);
      });

      roundTimes.push(durationMs);
      metrics.record('mempool-churn-round', durationMs, { round, txCount: count });
    }

    if (roundTimes.length >= 2) {
      const firstRound = roundTimes[0];
      const lastRound = roundTimes[roundTimes.length - 1];
      const degradation = lastRound / firstRound;

      console.log(`    Round times: ${roundTimes.map(t => formatMs(t)).join(', ')}`);
      console.log(`    Degradation ratio (last/first): ${degradation.toFixed(2)}x`);

      expect(degradation).to.be.lessThan(2.0,
        `Mempool churn degraded ${degradation.toFixed(2)}x over 5 rounds (threshold: 2.0x)`);
    }
  });

  it('measures mempool memory consumption', async function () {
    await clearMempoolDb(tracker);

    if (global.gc) global.gc();
    const heapBefore = process.memoryUsage().heapUsed;

    const count = Math.min(SCALE.mempoolTxs, utxoPool.length);
    await populateMempool(tracker, utxoPool, addressPool, count);

    if (global.gc) global.gc();
    const heapAfter = process.memoryUsage().heapUsed;

    const growthMB = (heapAfter - heapBefore) / (1024 * 1024);
    const perTxKB = (growthMB * 1024) / count;

    metrics.record('mempool-memory-MB', growthMB, { txCount: count, perTxKB });

    console.log(`    Mempool size: ${count} txs`);
    console.log(`    Memory growth: ${growthMB.toFixed(1)} MB (${perTxKB.toFixed(2)} KB/tx)`);

    // memdown stores everything in memory, so allow generous limits
    const maxMB = Math.max(200, count * 5 / 1024); // ~5KB per tx upper bound
    expect(growthMB).to.be.lessThan(maxMB,
      `Mempool memory usage ${growthMB.toFixed(1)}MB exceeds ${maxMB.toFixed(1)}MB for ${count} txs`);
  });
});
