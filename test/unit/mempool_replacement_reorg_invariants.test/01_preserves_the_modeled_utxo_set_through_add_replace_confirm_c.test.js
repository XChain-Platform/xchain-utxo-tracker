'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later


const {
  createTestTracker,
  closeTracker,
  TEST_KEYS,
  makeBlock,
  expect,
  fixedHash,
  outpoint,
  commitBlock,
  installMempoolNode,
  cleanupConfirmedMempoolTransactions,
  rewindTip,
  checkInvariants,
  seedTwoCoinbases,
  confirmedSet,
  originalAndReplacement
} = require('./support/invariants');

describe('mempool replacement and reorg invariants', function () {
  let tracker;

  beforeEach(async function () {
    tracker = await createTestTracker();
  });

  afterEach(async function () {
    await closeTracker(tracker);
  });

  it('preserves the modeled UTXO set through add, replace, confirm, cleanup, and rewind', async function () {
    const { coinbase0, coinbase1, block1 } = await seedTwoCoinbases(tracker);
    await checkInvariants(tracker, confirmedSet(coinbase0, coinbase1));

    const { original, replacement } = originalAndReplacement(coinbase0, coinbase1);
    const node = installMempoolNode(tracker, [original, replacement]);
    node.set([original.getId()]);
    await tracker.updateMempool();
    await checkInvariants(tracker, new Map([
      [outpoint(original.getId(), 0), { addressIndex: 2, value: 7000000000n }]
    ]));

    node.set([replacement.getId()]);
    await tracker.updateMempool();
    const afterReplace = new Map([
      [outpoint(coinbase1.getId(), 0), { addressIndex: 1, value: 3000000000n }],
      [outpoint(replacement.getId(), 0), { addressIndex: 3, value: 4500000000n }]
    ]);
    await checkInvariants(tracker, afterReplace);
    expect(await tracker.mempoolDb.getOutputsScriptPubKey(TEST_KEYS[2].scriptHash)).to.deep.equal([]);

    await commitBlock(tracker, makeBlock(2, block1.hash, [replacement], fixedHash('block-2')));
    await checkInvariants(tracker, afterReplace);
    await cleanupConfirmedMempoolTransactions(tracker, [replacement.getId()]);
    await checkInvariants(tracker, afterReplace);

    await rewindTip(tracker, 1, block1.hash);
    await checkInvariants(tracker, confirmedSet(coinbase0, coinbase1));
  });
});
