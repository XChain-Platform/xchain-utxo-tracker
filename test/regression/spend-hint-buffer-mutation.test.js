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

// Regression: input-hash reversal must operate on a COPY.
//
// Commit cfa0902 ("reverse prev-tx hash on a copy to stop spend-hint
// corruption", v1.0.8). The wire-order input hash is reversed to display order
// to derive prevTxHash. The bug: `nextInput.hash.reverse()` mutates in place,
// and the SAME decoded tx is parsed more than once (mempool ingest, then block
// confirmation). The first parse flipped the shared buffer; the second parse
// flipped it back, producing a double-reversed (corrupt) prevTxHash and a
// spend-hint that no longer matches the funding output. The fix wraps it in
// Buffer.from(...) so the source bytes are never touched.
//
// This reproduces the double-parse deterministically and asserts (a) the shared
// hash buffer is byte-identical before and after each parse, and (b) the
// recovered prevTxHash is stable and correct across both parses.

const { expect } = require('chai');
const sinon = require('sinon');
const {
  createTestTracker,
  closeTracker,
  makeTx,
  makeSpendInput,
} = require('../integration/helpers');

// Fixed display txid so the expectation is deterministic.
const PREV_TXID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00';

describe('Regression (cfa0902): input-hash reversal on a copy', function () {
  let tracker;

  beforeEach(async function () {
    tracker = await createTestTracker();
  });

  afterEach(async function () {
    await closeTracker(tracker);
  });

  async function parseInputsOnce(tx) {
    await tracker.db.beginTransaction();
    await tracker.parseTxInputs(tracker.db, tx, 'b'.repeat(64), false, false);
    await tracker.db.endTransaction();
  }

  it('does not mutate the shared input hash buffer across repeated parses', async function () {
    const input = makeSpendInput(PREV_TXID, 0);
    const tx = makeTx({ ins: [input], outs: [] });

    const original = Buffer.from(input.hash); // snapshot the wire-order bytes

    await parseInputsOnce(tx); // first pass (e.g. mempool ingest)
    expect(input.hash.equals(original), 'buffer changed after 1st parse').to.equal(true);

    await parseInputsOnce(tx); // second pass (e.g. block confirmation)
    expect(input.hash.equals(original), 'buffer changed after 2nd parse').to.equal(true);
  });

  it('recovers the same correct prevTxHash on both parses (no double-reversal)', async function () {
    const input = makeSpendInput(PREV_TXID, 3);
    const tx = makeTx({ ins: [input], outs: [] });

    const spy = sinon.spy(tracker.db, 'insertInput');

    await parseInputsOnce(tx);
    await parseInputsOnce(tx);

    expect(spy.callCount).to.equal(2);
    const first = spy.getCall(0).args[0].prevTxHash;
    const second = spy.getCall(1).args[0].prevTxHash;

    expect(first).to.equal(PREV_TXID);             // correct display order
    expect(second).to.equal(PREV_TXID);            // NOT the double-reversed value
    expect(first).to.equal(second);                // stable across re-parse
    expect(spy.getCall(0).args[0].prevOutputIndex).to.equal(3);

    spy.restore();
  });

  it('a coinbase input (0xFFFFFFFF) is skipped, leaving its hash untouched', async function () {
    const coinbase = { hash: Buffer.alloc(32, 0), index: 0xFFFFFFFF, script: Buffer.alloc(4) };
    const tx = makeTx({ ins: [coinbase], outs: [] });
    const spy = sinon.spy(tracker.db, 'insertInput');

    await parseInputsOnce(tx);

    expect(spy.called).to.equal(false); // coinbase is not traced
    expect(coinbase.hash.equals(Buffer.alloc(32, 0))).to.equal(true);
    spy.restore();
  });
});
