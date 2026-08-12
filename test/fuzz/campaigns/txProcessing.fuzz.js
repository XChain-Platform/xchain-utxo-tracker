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
  fc, FUZZ_RUNS, TEST_KEYS, SATOSHI,
  createTestTracker, closeTracker, randHash, randHash8,
  makeTx, makeCoinbaseTx, makeCoinbaseInput, makeSpendInput, makeBlock,
  processAndCommit, processBlocksAndCommit
} = require('../helpers');
const { satoshiToDecimalString } = require('../../../src/XChainUtxoTracker');

describe('Fuzz: Transaction Processing (P1)', function () {
  let tracker;

  beforeEach(async function () {
    tracker = await createTestTracker();
  });

  afterEach(async function () {
    await closeTracker(tracker);
  });

  describe('two-pass block processing', function () {
    it('every output from a coinbase-only block is retrievable', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 5 }),    // number of outputs per coinbase
          fc.integer({ min: 0, max: 9 }),     // address index
          async (numOutputs, addrIdx) => {
            const t = await createTestTracker();
            try {
              const outs = [];
              let totalValue = 0n;
              for (let i = 0; i < numOutputs; i++) {
                const value = BigInt((i + 1) * SATOSHI);
                outs.push({ value, script: TEST_KEYS[addrIdx].script });
                totalValue += value;
              }

              const tx = makeTx({ ins: [makeCoinbaseInput()], outs });
              const block = makeBlock(0, '0'.repeat(64), [tx]);
              await processAndCommit(t, block);

              const info = await t.getBalanceInfo(TEST_KEYS[addrIdx].address);
              expect(info.balances.confirmed).to.equal(satoshiToDecimalString(totalValue));
              expect(info.utxos.confirmed).to.equal(numOutputs);
            } finally {
              await closeTracker(t);
            }
          }
        ),
        { numRuns: Math.min(FUZZ_RUNS, 200) }
      );
    });

    it('outputs to multiple addresses in one block are all tracked', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 8 }),  // how many addresses to use
          async (numAddresses) => {
            const t = await createTestTracker();
            try {
              const outs = [];
              for (let i = 0; i < numAddresses; i++) {
                outs.push({
                  value: BigInt((i + 1) * SATOSHI),
                  script: TEST_KEYS[i].script
                });
              }

              const tx = makeTx({ ins: [makeCoinbaseInput()], outs });
              const block = makeBlock(0, '0'.repeat(64), [tx]);
              await processAndCommit(t, block);

              for (let i = 0; i < numAddresses; i++) {
                const info = await t.getBalanceInfo(TEST_KEYS[i].address);
                expect(info.balances.confirmed).to.equal(
                  satoshiToDecimalString(BigInt((i + 1) * SATOSHI))
                );
              }
            } finally {
              await closeTracker(t);
            }
          }
        ),
        { numRuns: Math.min(FUZZ_RUNS, 100) }
      );
    });

    it('intra-block spend: output created and spent in same block', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.bigInt({ min: 10000n, max: 10000000000n }),
          fc.integer({ min: 0, max: 8 }),
          async (value, addrIdx) => {
            const t = await createTestTracker();
            try {
              const recipientIdx = addrIdx;
              const spendToIdx = (addrIdx + 1) % 10;

              const coinbaseTx = makeTx({
                ins: [makeCoinbaseInput()],
                outs: [{ value, script: TEST_KEYS[recipientIdx].script }]
              });

              const spendTx = makeTx({
                ins: [makeSpendInput(coinbaseTx._txid, 0)],
                outs: [{ value, script: TEST_KEYS[spendToIdx].script }]
              });

              const block = makeBlock(0, '0'.repeat(64), [coinbaseTx, spendTx]);
              await processAndCommit(t, block);

              const origInfo = await t.getBalanceInfo(TEST_KEYS[recipientIdx].address);
              expect(origInfo.balances.confirmed).to.equal('0.00000000');

              const spendInfo = await t.getBalanceInfo(TEST_KEYS[spendToIdx].address);
              expect(spendInfo.balances.confirmed).to.equal(satoshiToDecimalString(value));
            } finally {
              await closeTracker(t);
            }
          }
        ),
        { numRuns: Math.min(FUZZ_RUNS, 100) }
      );
    });
  });

  describe('multi-block chain processing', function () {
    it('chain of blocks with spends maintains correct balance', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 8 }),
          fc.integer({ min: 0, max: 9 }),
          async (chainLength, addrIdx) => {
            const t = await createTestTracker();
            try {
              const coinbaseValue = BigInt(50 * SATOSHI);
              let prevHash = '0'.repeat(64);
              let prevTxId = null;

              for (let i = 0; i < chainLength; i++) {
                const txs = [];

                const cbTx = makeTx({
                  ins: [makeCoinbaseInput()],
                  outs: [{ value: coinbaseValue, script: TEST_KEYS[addrIdx].script }]
                });
                txs.push(cbTx);

                if (prevTxId) {
                  const otherIdx = (addrIdx + 1) % 10;
                  const spendTx = makeTx({
                    ins: [makeSpendInput(prevTxId, 0)],
                    outs: [{ value: coinbaseValue, script: TEST_KEYS[otherIdx].script }]
                  });
                  txs.push(spendTx);
                }

                const block = makeBlock(i, prevHash, txs);
                await processAndCommit(t, block);
                prevHash = block.hash;
                prevTxId = cbTx._txid;
              }

              const info = await t.getBalanceInfo(TEST_KEYS[addrIdx].address);
              expect(info.balances.confirmed).to.equal(satoshiToDecimalString(coinbaseValue));
              expect(info.utxos.confirmed).to.equal(1);
            } finally {
              await closeTracker(t);
            }
          }
        ),
        { numRuns: Math.min(FUZZ_RUNS, 50) }
      );
    });
  });

  describe('edge cases', function () {
    it('coinbase input (0xFFFFFFFF index) is not tracked as a spend', async function () {
      const coinbaseTx = makeCoinbaseTx(0, 50 * SATOSHI);
      const block = makeBlock(0, '0'.repeat(64), [coinbaseTx]);
      await processAndCommit(tracker, block);

      const info = await tracker.getBalanceInfo(TEST_KEYS[0].address);
      expect(info.balances.confirmed).to.equal(satoshiToDecimalString(BigInt(50 * SATOSHI)));
    });

    it('multiple transactions in one block all get processed', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 10 }),
          async (txCount) => {
            const t = await createTestTracker();
            try {
              const txs = [];
              let expectedTotal = 0n;

              for (let i = 0; i < txCount; i++) {
                const value = BigInt((i + 1) * SATOSHI);
                const tx = makeTx({
                  ins: [makeCoinbaseInput()],
                  outs: [{ value, script: TEST_KEYS[0].script }]
                });
                txs.push(tx);
                expectedTotal += value;
              }

              const block = makeBlock(0, '0'.repeat(64), txs);
              await processAndCommit(t, block);

              const info = await t.getBalanceInfo(TEST_KEYS[0].address);
              expect(info.balances.confirmed).to.equal(satoshiToDecimalString(expectedTotal));
              expect(info.utxos.confirmed).to.equal(txCount);
            } finally {
              await closeTracker(t);
            }
          }
        ),
        { numRuns: Math.min(FUZZ_RUNS, 100) }
      );
    });
  });
});
