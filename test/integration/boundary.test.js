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
  makeOutput, makeCoinbaseInput, makeSpendInput, makeTx, makeCoinbaseTx,
  makeBlock, processAndCommit, processBlocksAndCommit,
  buildCoinbaseChain, createTestTracker, closeTracker, coinAmount
} = require('./support/helpers');

// 1. Same-block spend chains
describe('Boundary: Same-block spend chains', function () {
  let tracker;

  beforeEach(async function () { tracker = await createTestTracker(); });
  afterEach(async function () { await closeTracker(tracker); });

  it('handles A->B spend within the same block', async function () {
    // Tx A: coinbase pays address 0
    const txA = makeCoinbaseTx(0, 50 * SATOSHI);
    const txAId = txA._txid;

    // Tx B: spends A's output, pays address 1
    const txB = makeTx({
      ins: [makeSpendInput(txAId, 0)],
      outs: [makeOutput(1, 50 * SATOSHI)]
    });

    const block = makeBlock(0, '0'.repeat(64), [txA, txB]);
    await processAndCommit(tracker, block);

    // Address 0 should have 0 UTXOs (spent in same block)
    const utxos0 = await tracker.getUtxosAddress(TEST_KEYS[0].address);
    expect(utxos0).to.have.length(0);

    // Address 1 should have 1 UTXO
    const utxos1 = await tracker.getUtxosAddress(TEST_KEYS[1].address);
    expect(utxos1).to.have.length(1);
    expect(utxos1[0].amount).to.equal(coinAmount(50));
  });

  it('handles A->B->C chain within the same block', async function () {
    const txA = makeCoinbaseTx(0, 50 * SATOSHI);

    const txB = makeTx({
      ins: [makeSpendInput(txA._txid, 0)],
      outs: [makeOutput(1, 50 * SATOSHI)]
    });

    const txC = makeTx({
      ins: [makeSpendInput(txB._txid, 0)],
      outs: [makeOutput(2, 50 * SATOSHI)]
    });

    const block = makeBlock(0, '0'.repeat(64), [txA, txB, txC]);
    await processAndCommit(tracker, block);

    expect(await tracker.getUtxosAddress(TEST_KEYS[0].address)).to.have.length(0);
    expect(await tracker.getUtxosAddress(TEST_KEYS[1].address)).to.have.length(0);

    const utxos2 = await tracker.getUtxosAddress(TEST_KEYS[2].address);
    expect(utxos2).to.have.length(1);
    expect(utxos2[0].amount).to.equal(coinAmount(50));
  });
});

describe('Boundary: Same-block spend chains', function () {
  let tracker;

  beforeEach(async function () { tracker = await createTestTracker(); });
  afterEach(async function () { await closeTracker(tracker); });

  it('handles A->B->C->D chain (4 hops) within the same block', async function () {
    const txA = makeCoinbaseTx(0, 10 * SATOSHI);

    const txB = makeTx({
      ins: [makeSpendInput(txA._txid, 0)],
      outs: [makeOutput(1, 10 * SATOSHI)]
    });

    const txC = makeTx({
      ins: [makeSpendInput(txB._txid, 0)],
      outs: [makeOutput(2, 10 * SATOSHI)]
    });

    const txD = makeTx({
      ins: [makeSpendInput(txC._txid, 0)],
      outs: [makeOutput(3, 10 * SATOSHI)]
    });

    const block = makeBlock(0, '0'.repeat(64), [txA, txB, txC, txD]);
    await processAndCommit(tracker, block);

    expect(await tracker.getUtxosAddress(TEST_KEYS[0].address)).to.have.length(0);
    expect(await tracker.getUtxosAddress(TEST_KEYS[1].address)).to.have.length(0);
    expect(await tracker.getUtxosAddress(TEST_KEYS[2].address)).to.have.length(0);

    const utxos3 = await tracker.getUtxosAddress(TEST_KEYS[3].address);
    expect(utxos3).to.have.length(1);
    expect(utxos3[0].amount).to.equal(coinAmount(10));
  });
});

// 2. Large vout indices
describe('Boundary: Large vout indices', function () {
  let tracker;

  beforeEach(async function () { tracker = await createTestTracker(); });
  afterEach(async function () { await closeTracker(tracker); });

  it('indexes a transaction with many outputs (100)', async function () {
    const outs = [];
    for (let i = 0; i < 100; i++) {
      outs.push(makeOutput(i % 10, 1 * SATOSHI));
    }
    const tx = makeTx({
      ins: [makeCoinbaseInput()],
      outs
    });

    const block = makeBlock(0, '0'.repeat(64), [tx]);
    await processAndCommit(tracker, block);

    // Each of 10 addresses should have 10 UTXOs
    for (let i = 0; i < 10; i++) {
      const utxos = await tracker.getUtxosAddress(TEST_KEYS[i].address);
      expect(utxos).to.have.length(10);
    }
  });

  it('correctly records vout index for multi-output transaction', async function () {
    const tx = makeTx({
      ins: [makeCoinbaseInput()],
      outs: [
        makeOutput(0, 1 * SATOSHI),
        makeOutput(1, 2 * SATOSHI),
        makeOutput(2, 3 * SATOSHI)
      ]
    });

    const block = makeBlock(0, '0'.repeat(64), [tx]);
    await processAndCommit(tracker, block);

    const utxos0 = await tracker.getUtxosAddress(TEST_KEYS[0].address);
    expect(utxos0[0].vout).to.equal(0);
    expect(utxos0[0].amount).to.equal(coinAmount(1));

    const utxos1 = await tracker.getUtxosAddress(TEST_KEYS[1].address);
    expect(utxos1[0].vout).to.equal(1);
    expect(utxos1[0].amount).to.equal(coinAmount(2));

    const utxos2 = await tracker.getUtxosAddress(TEST_KEYS[2].address);
    expect(utxos2[0].vout).to.equal(2);
    expect(utxos2[0].amount).to.equal(coinAmount(3));
  });
});

// 3. Zero-value outputs
describe('Boundary: Zero-value outputs', function () {
  let tracker;

  beforeEach(async function () { tracker = await createTestTracker(); });
  afterEach(async function () { await closeTracker(tracker); });

  it('indexes a zero-value output without error', async function () {
    const tx = makeTx({
      ins: [makeCoinbaseInput()],
      outs: [makeOutput(0, 0)]
    });

    const block = makeBlock(0, '0'.repeat(64), [tx]);
    await processAndCommit(tracker, block);

    const utxos = await tracker.getUtxosAddress(TEST_KEYS[0].address);
    expect(utxos).to.have.length(1);
    expect(utxos[0].amount).to.equal(coinAmount(0));
  });

  it('zero-value output does not affect balance', async function () {
    const tx = makeTx({
      ins: [makeCoinbaseInput()],
      outs: [
        makeOutput(0, 50 * SATOSHI),
        makeOutput(0, 0)
      ]
    });

    const block = makeBlock(0, '0'.repeat(64), [tx]);
    await processAndCommit(tracker, block);

    const info = await tracker.getBalanceInfo(TEST_KEYS[0].address);
    expect(info.balances.confirmed).to.equal('50.00000000');
    expect(info.utxos.confirmed).to.equal(2);
  });
});

// 4. Many UTXOs per address
describe('Boundary: Many UTXOs per address', function () {
  let tracker;

  beforeEach(async function () { tracker = await createTestTracker(); });
  afterEach(async function () { await closeTracker(tracker); });

  it('handles 500 UTXOs for a single address', async function () {
    // Create 500 coinbase blocks all paying address 0
    const blocks = buildCoinbaseChain(500, 0, 0);
    await processBlocksAndCommit(tracker, blocks);

    const utxos = await tracker.getUtxosAddress(TEST_KEYS[0].address);
    expect(utxos).to.have.length(500);

    const info = await tracker.getBalanceInfo(TEST_KEYS[0].address);
    expect(info.balances.confirmed).to.equal('25000.00000000'); // 500 * 50 BTC
    expect(info.utxos.confirmed).to.equal(500);
  });
});

// 5. BigInt balance precision (the core fix validation)
describe('Boundary: Balance precision with large values', function () {
  let tracker;

  beforeEach(async function () { tracker = await createTestTracker(); });
  afterEach(async function () { await closeTracker(tracker); });

  it('reports precise balance for Dogecoin-scale values', async function () {
    // 1 billion DOGE = 100,000,000,000,000,000 satoshis
    const largeSatoshis = BigInt('100000000000000000');

    const tx = makeTx({
      ins: [makeCoinbaseInput()],
      outs: [makeOutput(0, largeSatoshis)]
    });

    const block = makeBlock(0, '0'.repeat(64), [tx]);
    await processAndCommit(tracker, block);

    const info = await tracker.getBalanceInfo(TEST_KEYS[0].address);
    expect(info.balances.confirmed).to.equal('1000000000.00000000');
  });

  it('aggregates multiple large-value UTXOs precisely', async function () {
    // Two outputs each worth 500M DOGE
    const val = BigInt('50000000000000000'); // 500M DOGE in satoshis

    const tx = makeTx({
      ins: [makeCoinbaseInput()],
      outs: [makeOutput(0, val), makeOutput(0, val)]
    });

    const block = makeBlock(0, '0'.repeat(64), [tx]);
    await processAndCommit(tracker, block);

    const info = await tracker.getBalanceInfo(TEST_KEYS[0].address);
    // 500M + 500M = 1B DOGE
    expect(info.balances.confirmed).to.equal('1000000000.00000000');
  });

  it('produces precise balance at Number.MAX_SAFE_INTEGER boundary', async function () {
    // Number.MAX_SAFE_INTEGER = 9007199254740991 satoshis
    // As float this would lose precision in addition
    const val1 = BigInt('9007199254740990');
    const val2 = BigInt('1');

    const tx = makeTx({
      ins: [makeCoinbaseInput()],
      outs: [makeOutput(0, val1), makeOutput(0, val2)]
    });

    const block = makeBlock(0, '0'.repeat(64), [tx]);
    await processAndCommit(tracker, block);

    const info = await tracker.getBalanceInfo(TEST_KEYS[0].address);
    // 9007199254740990 + 1 = 9007199254740991 satoshis = 90071992.54740991
    expect(info.balances.confirmed).to.equal('90071992.54740991');
  });
});
