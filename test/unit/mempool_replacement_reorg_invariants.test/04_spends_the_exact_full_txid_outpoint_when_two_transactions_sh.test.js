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

  it('spends the exact full-txid outpoint when two transactions share a stored prefix', async function () {
    const sharedPrefix = '0123456789abcdef';
    const first = makeTx({
      txid: sharedPrefix + '00'.repeat(24),
      ins: [{ hash: Buffer.alloc(32), index: 0xffffffff, script: Buffer.alloc(4) }],
      outs: [makeOutput(0, 5000000000)]
    });
    const second = makeTx({
      txid: sharedPrefix + '11'.repeat(24),
      ins: [{ hash: Buffer.alloc(32), index: 0xffffffff, script: Buffer.alloc(4) }],
      outs: [makeOutput(1, 3000000000)]
    });
    const block0 = makeBlock(0, '0'.repeat(64), [first], fixedHash('collision-block-0'));
    const block1 = makeBlock(1, block0.hash, [second], fixedHash('collision-block-1'));
    await commitBlock(tracker, block0);
    await commitBlock(tracker, block1);

    const spend = makeTx({
      txid: fixedHash('collision-spend'),
      ins: [makeSpendInput(first.getId())],
      outs: [makeOutput(2, 4900000000)]
    });
    await commitBlock(tracker, makeBlock(2, block1.hash, [spend], fixedHash('collision-block-2')));

    await checkInvariants(tracker, new Map([
      [outpoint(second.getId(), 0), { addressIndex: 1, value: 3000000000n }],
      [outpoint(spend.getId(), 0), { addressIndex: 2, value: 4900000000n }]
    ]));
  });
});
