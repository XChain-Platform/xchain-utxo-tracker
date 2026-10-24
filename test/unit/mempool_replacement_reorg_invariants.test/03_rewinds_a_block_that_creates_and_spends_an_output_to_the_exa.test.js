'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later


const {
  createTestTracker,
  closeTracker,
  makeOutput,
  makeSpendInput,
  makeTx,
  makeBlock,
  fixedHash,
  outpoint,
  commitBlock,
  rewindTip,
  checkInvariants
} = require('./support/invariants');

describe('mempool replacement and reorg invariants', function () {
  let tracker;

  beforeEach(async function () {
    tracker = await createTestTracker();
  });

  afterEach(async function () {
    await closeTracker(tracker);
  });

  it('rewinds a block that creates and spends an output to the exact pre-block set', async function () {
    const funding = makeTx({
      txid: fixedHash('same-block-funding'),
      ins: [{ hash: Buffer.alloc(32), index: 0xffffffff, script: Buffer.alloc(4) }],
      outs: [makeOutput(0, 5000000000)]
    });
    const block0 = makeBlock(0, '0'.repeat(64), [funding], fixedHash('same-block-0'));
    await commitBlock(tracker, block0);

    const parent = makeTx({
      txid: fixedHash('same-block-parent'),
      ins: [makeSpendInput(funding.getId())],
      outs: [makeOutput(1, 4900000000)]
    });
    const child = makeTx({
      txid: fixedHash('same-block-child'),
      ins: [makeSpendInput(parent.getId())],
      outs: [makeOutput(2, 4800000000)]
    });
    const block1 = makeBlock(1, block0.hash, [parent, child], fixedHash('same-block-1'));
    await commitBlock(tracker, block1);
    await checkInvariants(tracker, new Map([
      [outpoint(child.getId(), 0), { addressIndex: 2, value: 4800000000n }]
    ]));

    await rewindTip(tracker, 0, block0.hash);
    await checkInvariants(tracker, new Map([
      [outpoint(funding.getId(), 0), { addressIndex: 0, value: 5000000000n }]
    ]));
  });
});
