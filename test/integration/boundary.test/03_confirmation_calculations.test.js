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
  TEST_KEYS, makeCoinbaseTx, makeBlock, processAndCommit,
  createTestTracker, closeTracker, randHash
} = require('../support/helpers');

// 8. Confirmation calculations
describe('Boundary: Confirmation calculations', function () {
  let tracker;

  beforeEach(async function () { tracker = await createTestTracker(); });
  afterEach(async function () { await closeTracker(tracker); });

  it('calculates correct confirmations for genesis block output', async function () {
    tracker.blockchainInfoLastBlock = 800000;

    const tx = makeCoinbaseTx(0);
    const block = makeBlock(0, '0'.repeat(64), [tx]);
    await processAndCommit(tracker, block);

    const utxos = await tracker.getUtxosAddress(TEST_KEYS[0].address);
    expect(utxos[0].confirmations).to.equal(800001); // 800000 - 0 + 1
  });

  it('calculates confirmations = 1 when output is at chain tip', async function () {
    tracker.blockchainInfoLastBlock = 500;

    const tx = makeCoinbaseTx(0);
    const block = makeBlock(500, randHash(), [tx]);
    await processAndCommit(tracker, block);

    const utxos = await tracker.getUtxosAddress(TEST_KEYS[0].address);
    expect(utxos[0].confirmations).to.equal(1); // 500 - 500 + 1
  });
});
