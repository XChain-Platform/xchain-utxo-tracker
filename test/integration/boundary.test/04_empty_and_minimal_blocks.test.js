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

// 9. Empty/minimal blocks
describe('Boundary: Empty and minimal blocks', function () {
  let tracker;

  beforeEach(async function () { tracker = await createTestTracker(); });
  afterEach(async function () { await closeTracker(tracker); });

  it('processes a block with only a coinbase transaction', async function () {
    const block = makeBlock(0, '0'.repeat(64), [makeCoinbaseTx(0)]);
    await processAndCommit(tracker, block);

    const height = await tracker.db.getLastBlockHeight();
    expect(height).to.equal(0);
  });

  it('processes a block with zero transactions', async function () {
    const block = makeBlock(0, '0'.repeat(64), []);
    await processAndCommit(tracker, block);

    const height = await tracker.db.getLastBlockHeight();
    expect(height).to.equal(0);
  });

  it('processes two consecutive empty blocks', async function () {
    const block0 = makeBlock(0, '0'.repeat(64), []);
    const block1 = makeBlock(1, block0.hash, []);

    await processAndCommit(tracker, block0);
    await processAndCommit(tracker, block1);

    expect(await tracker.db.getLastBlockHeight()).to.equal(1);
  });
});
