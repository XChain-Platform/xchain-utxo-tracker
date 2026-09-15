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
  makeCoinbaseTx, makeBlock, processAndCommit, createTestTracker, closeTracker
} = require('../support/helpers');

// 7. Coinbase input handling
describe('Boundary: Coinbase input skip', function () {
  let tracker;

  beforeEach(async function () { tracker = await createTestTracker(); });
  afterEach(async function () { await closeTracker(tracker); });

  it('skips coinbase input (index=0xFFFFFFFF) without creating I record', async function () {
    const tx = makeCoinbaseTx(0);
    const block = makeBlock(0, '0'.repeat(64), [tx]);
    await processAndCommit(tracker, block);

    // No input record should exist for coinbase
    const input = await tracker.db.getInput('0'.repeat(16), 4294967295);
    expect(input).to.be.null;
  });
});
