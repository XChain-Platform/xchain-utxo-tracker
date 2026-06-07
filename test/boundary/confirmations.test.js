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

// ─── Boundary: confirmation count math at the chain tip ───────────────────────
//
// getUtxosAddress() reports confirmations as `blockchainInfoLastBlock - height + 1`.
// The interesting edges are right at the tip: an output mined in the tip block is
// 1-confirmed, not 0; an output exactly one block back is 2-confirmed; and a
// mempool (unconfirmed) output reports 0 with a null height. We also pin the
// behaviour when the tracker's cached tip momentarily trails an output's height
// (height > tip) — the formula is unclamped, so this documents whether a stale
// tip can surface a 0/negative confirmation count to callers.

const { expect } = require('chai');
const {
  TEST_KEYS,
  createTestTracker,
  closeTracker,
} = require('../integration/helpers');

const ADDR = TEST_KEYS[0];

async function storeConfirmedOutput(tracker, { height, txHash, vout = 0, value = 100000000 }) {
  await tracker.db.beginTransaction();
  await tracker.db.insertOutput({
    scriptPubKey: ADDR.scriptHash,
    txHash,
    outputIndex: vout,
    value,
    height,
    fullTxHash: txHash + 'ab'.repeat(24), // pad to a 64-hex full txid (guard requires it)
  });
  await tracker.db.endTransaction();
}

describe('Boundary: confirmation count at the chain tip', function () {
  let tracker;

  beforeEach(async function () {
    tracker = await createTestTracker();
  });

  afterEach(async function () {
    await closeTracker(tracker);
  });

  it('an output mined in the tip block is 1-confirmed (not 0)', async function () {
    tracker.blockchainInfoLastBlock = 1000;
    await storeConfirmedOutput(tracker, { height: 1000, txHash: '11'.repeat(8) });

    const utxos = await tracker.getUtxosAddress(ADDR.address);
    expect(utxos).to.have.length(1);
    expect(utxos[0].confirmations).to.equal(1);
    expect(utxos[0].height).to.equal(1000);
  });

  it('an output one block back from the tip is 2-confirmed', async function () {
    tracker.blockchainInfoLastBlock = 1000;
    await storeConfirmedOutput(tracker, { height: 999, txHash: '22'.repeat(8) });

    const utxos = await tracker.getUtxosAddress(ADDR.address);
    expect(utxos[0].confirmations).to.equal(2);
  });

  it('a genesis-height (0) output counts every block: tip+1 confirmations', async function () {
    tracker.blockchainInfoLastBlock = 5;
    await storeConfirmedOutput(tracker, { height: 0, txHash: '33'.repeat(8) });

    const utxos = await tracker.getUtxosAddress(ADDR.address);
    expect(utxos[0].confirmations).to.equal(6); // 5 - 0 + 1
  });

  it('an output whose height exceeds a stale cached tip reports 0 confirmations, unclamped', async function () {
    // The tracker's cached tip can momentarily trail the indexed height during
    // catch-up. The formula is not clamped to >= 1, so this pins the observable
    // boundary: height == tip+1 yields exactly 0 (a value a stale tip can emit).
    tracker.blockchainInfoLastBlock = 1000;
    await storeConfirmedOutput(tracker, { height: 1001, txHash: '44'.repeat(8) });

    const utxos = await tracker.getUtxosAddress(ADDR.address);
    expect(utxos[0].confirmations).to.equal(0);
  });
});
