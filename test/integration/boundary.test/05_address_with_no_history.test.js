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
  SATOSHI, TEST_KEYS, makeOutput, makeSpendInput, makeTx, makeCoinbaseTx,
  makeBlock, processAndCommit, createTestTracker, closeTracker
} = require('../support/helpers');

// 10. Address with no UTXOs
describe('Boundary: Address with no history', function () {
  let tracker;

  beforeEach(async function () { tracker = await createTestTracker(); });
  afterEach(async function () { await closeTracker(tracker); });

  it('returns empty UTXOs for address that never received funds', async function () {
    const utxos = await tracker.getUtxosAddress(TEST_KEYS[5].address);
    expect(utxos).to.be.an('array').with.length(0);
  });

  it('returns zero balance for address that never received funds', async function () {
    const info = await tracker.getBalanceInfo(TEST_KEYS[5].address);
    expect(info.balances.confirmed).to.equal('0.00000000');
    expect(info.balances.pending).to.equal('0.00000000');
    expect(info.utxos.confirmed).to.equal(0);
  });

  it('returns empty UTXOs after all outputs are spent', async function () {
    const coinbase = makeCoinbaseTx(0, 50 * SATOSHI);
    const block0 = makeBlock(0, '0'.repeat(64), [coinbase]);

    const spend = makeTx({
      ins: [makeSpendInput(coinbase._txid, 0)],
      outs: [makeOutput(1, 50 * SATOSHI)]
    });
    const block1 = makeBlock(1, block0.hash, [makeCoinbaseTx(2), spend]);

    await processAndCommit(tracker, block0);
    await processAndCommit(tracker, block1);

    const utxos = await tracker.getUtxosAddress(TEST_KEYS[0].address);
    expect(utxos).to.have.length(0);

    const info = await tracker.getBalanceInfo(TEST_KEYS[0].address);
    expect(info.balances.confirmed).to.equal('0.00000000');
  });
});
