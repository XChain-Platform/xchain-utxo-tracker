'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later


const {
  createTestTracker,
  closeTracker,
  TEST_KEYS,
  makeOutput,
  makeSpendInput,
  makeTx,
  makeBlock,
  expect,
  fixedHash,
  outpoint,
  commitBlock,
  installMempoolNode,
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

  it('discards a failed replacement batch and converges on retry', async function () {
    const funding = makeTx({
      txid: fixedHash('error-funding'),
      ins: [{ hash: Buffer.alloc(32), index: 0xffffffff, script: Buffer.alloc(4) }],
      outs: [makeOutput(0, 5000000000)]
    });
    await commitBlock(tracker, makeBlock(0, '0'.repeat(64), [funding], fixedHash('error-block')));

    const original = makeTx({
      txid: fixedHash('error-original'),
      ins: [makeSpendInput(funding.getId())],
      outs: [makeOutput(1, 4900000000)]
    });
    const replacement = makeTx({
      txid: fixedHash('error-replacement'),
      ins: [makeSpendInput(funding.getId())],
      outs: [makeOutput(2, 4800000000)]
    });
    const wrongTransaction = makeTx({
      txid: fixedHash('wrong-decoder-result'),
      ins: replacement.ins,
      outs: replacement.outs
    });
    const node = installMempoolNode(tracker, [original, replacement]);

    node.set([original.getId()]);
    await tracker.updateMempool();

    node.setTransaction(replacement.getId(), wrongTransaction);
    node.set([replacement.getId()]);
    await tracker.updateMempool();
    expect(tracker.mempoolBusy).to.equal(false);
    expect(tracker.mempoolReconverged).to.equal(false);
    expect(await tracker.mempoolDb.getOutputsScriptPubKey(TEST_KEYS[1].scriptHash)).to.deep.equal([]);
    expect(await tracker.mempoolDb.getOutputsScriptPubKey(TEST_KEYS[2].scriptHash)).to.deep.equal([]);

    node.setTransaction(replacement.getId(), replacement);
    await tracker.updateMempool();
    const expected = new Map([
      [outpoint(replacement.getId(), 0), { addressIndex: 2, value: 4800000000n }]
    ]);
    expect(tracker.mempoolReconverged).to.equal(true);
    await checkInvariants(tracker, expected);
  });
});
