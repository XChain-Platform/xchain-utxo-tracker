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
const autocannon = require('autocannon');
const {
  SCALE,
  createTestTracker,
  closeTracker,
  resetTxCounter,
  generateAddressPool,
  seedTracker,
  processAndCommit,
  buildDenseChain,
  startHttpServer,
  MetricsCollector,
  measureAsync,
  formatMs,
  formatRate
} = require('./support/helpers');

const highLoad = {};
const combinedLoad = {};

async function setupQueryLoad(context, label) {
  resetTxCounter();
  context.tracker = await createTestTracker();
  context.addressPool = generateAddressPool(SCALE.addresses);
  context.metrics = new MetricsCollector(label);

  const seedBlocks = Math.max(50, Math.floor(SCALE.blocks / 5));
  await seedTracker(context.tracker, seedBlocks, context.addressPool, SCALE.txsPerBlock);

  context.httpCtx = await startHttpServer(context.tracker);
}

async function closeQueryLoad(context) {
  context.metrics.printTable();
  context.metrics.saveIfRequested();
  if (context.httpCtx) await context.httpCtx.close();
  await closeTracker(context.tracker);
}

function buildAddressRequests(endpoint) {
  return highLoad.addressPool.map(key => ({
    method: 'GET',
    path: `/${endpoint}/${key.address}`
  }));
}

async function runAutocannon(opts) {
  return new Promise((resolve, reject) => {
    const instance = autocannon({
      url: highLoad.httpCtx.baseUrl,
      connections: SCALE.queryConns,
      duration: SCALE.querySecs,
      ...opts
    }, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

function recordAutocannonResult(label, result) {
  highLoad.metrics.record(label + ' (avg)', result.latency.average, {
    reqPerSec: result.requests.average,
    totalRequests: result.requests.total,
    errors: result.errors,
    timeouts: result.timeouts
  });
  // Record percentile values as separate metrics for the table
  highLoad.metrics.record(label + ' (p50)', result.latency.p50);
  highLoad.metrics.record(label + ' (p99)', result.latency.p99);

  console.log(`    ${label}:`);
  console.log(`      Requests: ${result.requests.total} total, ${result.requests.average.toFixed(1)} req/s`);
  console.log(`      Latency:  avg=${formatMs(result.latency.average)} p50=${formatMs(result.latency.p50)} p95=${formatMs(result.latency.p95)} p99=${formatMs(result.latency.p99)} max=${formatMs(result.latency.max)}`);
  console.log(`      Errors:   ${result.errors} errors, ${result.timeouts} timeouts`);
}

async function measureBalanceLoad() {
  const requests = buildAddressRequests('balance');
  const result = await runAutocannon({ requests });

  recordAutocannonResult('GET /balance', result);

  expect(result.errors).to.equal(0, 'No HTTP errors expected');
  expect(result.timeouts).to.equal(0, 'No timeouts expected');
  expect(result.requests.average).to.be.greaterThan(0, 'Should serve requests');
}

async function measureUtxoLoad() {
  const requests = buildAddressRequests('utxos');
  const result = await runAutocannon({ requests });

  recordAutocannonResult('GET /utxos', result);

  expect(result.errors).to.equal(0, 'No HTTP errors expected');
  expect(result.timeouts).to.equal(0, 'No timeouts expected');
}

async function measureInfoLoad() {
  const requests = buildAddressRequests('info');
  const result = await runAutocannon({ requests });

  recordAutocannonResult('GET /info', result);

  expect(result.errors).to.equal(0, 'No HTTP errors expected');
  expect(result.timeouts).to.equal(0, 'No timeouts expected');
}

async function measureMixedEndpointLoad() {
  // Interleave different endpoints
  const mixed = [];
  for (const key of highLoad.addressPool) {
    mixed.push({ method: 'GET', path: `/balance/${key.address}` });
    mixed.push({ method: 'GET', path: `/utxos/${key.address}` });
    mixed.push({ method: 'GET', path: `/info/${key.address}` });
  }

  const result = await runAutocannon({ requests: mixed });

  recordAutocannonResult('Mixed endpoints', result);

  expect(result.errors).to.equal(0, 'No HTTP errors expected');
  expect(result.timeouts).to.equal(0, 'No timeouts expected');
}

describe('Perf: High Query Load', function () {
  before(() => setupQueryLoad(highLoad, 'Query Load'));
  after(() => closeQueryLoad(highLoad));

  it('measures /balance/:address response times under load', measureBalanceLoad);
  it('measures /utxos/:address response times under load', measureUtxoLoad);
  it('measures /info/:address response times under load', measureInfoLoad);
  it('measures mixed endpoint load', measureMixedEndpointLoad);
});

function startBackgroundIndexing(indexBlocks, state) {
  // Start background indexing
  return (async () => {
    for (const block of indexBlocks) {
      if (state.indexingDone) break;
      await processAndCommit(combinedLoad.tracker, block);
      state.blocksIndexed++;
      // Pace indexing to ~5 blocks/sec so it overlaps the query run instead
      // of finishing before or after it.
      // Pace indexing to ~5 blocks/sec
      await new Promise(r => setTimeout(r, 200));
    }
  })();
}

async function runCombinedQueries(requests) {
  return new Promise((resolve, reject) => {
    autocannon({
      url: combinedLoad.httpCtx.baseUrl,
      connections: Math.max(2, Math.floor(SCALE.queryConns / 2)),
      duration: SCALE.querySecs,
      requests
    }, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

describe('Perf: Combined Indexing + Query Load', function () {
  before(() => setupQueryLoad(combinedLoad, 'Combined Load'));
  after(() => closeQueryLoad(combinedLoad));

  it('serves queries during concurrent block indexing', async function () {
    // Prepare blocks to index during the test
    const indexBlocks = buildDenseChain(
      Math.max(10, Math.floor(SCALE.querySecs * 5)),
      combinedLoad.addressPool,
      SCALE.txsPerBlock
    );

    const state = { blocksIndexed: 0, indexingDone: false };
    const indexingPromise = startBackgroundIndexing(indexBlocks, state);

    // Run query load concurrently
    const requests = combinedLoad.addressPool.map(key => ({
      method: 'GET',
      path: `/balance/${key.address}`
    }));

    const queryResult = await runCombinedQueries(requests);

    // Stop indexing
    state.indexingDone = true;
    await indexingPromise;
    const blocksIndexed = state.blocksIndexed;

    combinedLoad.metrics.record('combined-query (avg)', queryResult.latency.average, {
      reqPerSec: queryResult.requests.average,
      blocksIndexedDuring: blocksIndexed
    });
    combinedLoad.metrics.record('combined-query (p99)', queryResult.latency.p99);

    console.log(`    Blocks indexed during test: ${blocksIndexed}`);
    console.log(`    Query throughput: ${queryResult.requests.average.toFixed(1)} req/s`);
    console.log(`    Query latency: avg=${formatMs(queryResult.latency.average)} p99=${formatMs(queryResult.latency.p99)}`);
    console.log(`    Errors: ${queryResult.errors}, Timeouts: ${queryResult.timeouts}`);

    expect(queryResult.errors).to.equal(0, 'No query errors during indexing');
    expect(queryResult.timeouts).to.equal(0, 'No query timeouts during indexing');
    expect(blocksIndexed).to.be.greaterThan(0, 'Should have indexed blocks concurrently');
  });
});
