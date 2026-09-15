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
  SATOSHI, TEST_KEYS, makeOutput, makeCoinbaseInput, makeSpendInput,
  makeTx, makeCoinbaseTx, makeBlock, processAndCommit,
  createTestTracker, closeTracker, coinAmount
} = require('../support/helpers');

// 11. Spending one of multiple outputs from the same transaction
describe('Boundary: Partial spend of multi-output tx', function () {
  let tracker;

  beforeEach(async function () { tracker = await createTestTracker(); });
  afterEach(async function () { await closeTracker(tracker); });

  it('spends vout=0 but leaves vout=1 intact', async function () {
    const tx = makeTx({
      ins: [makeCoinbaseInput()],
      outs: [
        makeOutput(0, 30 * SATOSHI),
        makeOutput(0, 20 * SATOSHI)
      ]
    });
    const block0 = makeBlock(0, '0'.repeat(64), [tx]);

    const spendTx = makeTx({
      ins: [makeSpendInput(tx._txid, 0)],
      outs: [makeOutput(1, 30 * SATOSHI)]
    });
    const block1 = makeBlock(1, block0.hash, [makeCoinbaseTx(2), spendTx]);

    await processAndCommit(tracker, block0);
    await processAndCommit(tracker, block1);

    // Address 0 should have only vout=1 left (20 BTC)
    const utxos = await tracker.getUtxosAddress(TEST_KEYS[0].address);
    expect(utxos).to.have.length(1);
    expect(utxos[0].vout).to.equal(1);
    expect(utxos[0].amount).to.equal(coinAmount(20));

    const info = await tracker.getBalanceInfo(TEST_KEYS[0].address);
    expect(info.balances.confirmed).to.equal('20.00000000');
  });

  it('spends vout=1 but leaves vout=0 intact', async function () {
    const tx = makeTx({
      ins: [makeCoinbaseInput()],
      outs: [
        makeOutput(0, 30 * SATOSHI),
        makeOutput(0, 20 * SATOSHI)
      ]
    });
    const block0 = makeBlock(0, '0'.repeat(64), [tx]);

    const spendTx = makeTx({
      ins: [makeSpendInput(tx._txid, 1)],
      outs: [makeOutput(1, 20 * SATOSHI)]
    });
    const block1 = makeBlock(1, block0.hash, [makeCoinbaseTx(2), spendTx]);

    await processAndCommit(tracker, block0);
    await processAndCommit(tracker, block1);

    const utxos = await tracker.getUtxosAddress(TEST_KEYS[0].address);
    expect(utxos).to.have.length(1);
    expect(utxos[0].vout).to.equal(0);
    expect(utxos[0].amount).to.equal(coinAmount(30));
  });
});
