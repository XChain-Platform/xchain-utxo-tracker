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
  fc, FUZZ_RUNS, SATOSHI, SATOSHI_BIGINT, MAX_SATOSHI,
  arbSatoshiValue, arbSatoshiValueExtreme,
  createTestTracker, closeTracker, TEST_KEYS, randHash, randHash8,
  makeCoinbaseTx, makeTx, makeBlock, makeSpendInput, makeCoinbaseInput,
  processAndCommit, processBlocksAndCommit
} = require('../helpers');
const { satoshiToDecimalString } = require('../../../src/XChainUtxoTracker');

describe('Fuzz: Balance Calculation (P0)', function () {

  describe('satoshiToDecimalString', function () {
    it('always returns a valid decimal string with 8 decimal places for any BigInt', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.bigInt({ min: -(1n << 63n), max: (1n << 63n) - 1n }),
          async (value) => {
            const result = satoshiToDecimalString(value);
            expect(result).to.be.a('string');
            // Must match: optional minus, digits, dot, exactly 8 digits
            expect(result).to.match(/^-?\d+\.\d{8}$/);
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });

    it('zero produces "0.00000000"', function () {
      expect(satoshiToDecimalString(0n)).to.equal('0.00000000');
      expect(satoshiToDecimalString(0)).to.equal('0.00000000');
      expect(satoshiToDecimalString('0')).to.equal('0.00000000');
    });

    it('1 satoshi produces "0.00000001"', function () {
      expect(satoshiToDecimalString(1n)).to.equal('0.00000001');
    });

    it('1 BTC (100000000 satoshis) produces "1.00000000"', function () {
      expect(satoshiToDecimalString(SATOSHI_BIGINT)).to.equal('1.00000000');
    });

    it('negative values produce negative strings', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.bigInt({ min: 1n, max: MAX_SATOSHI }),
          async (value) => {
            const result = satoshiToDecimalString(-value);
            expect(result).to.match(/^-\d+\.\d{8}$/);
            const positive = satoshiToDecimalString(value);
            expect(result).to.equal('-' + positive);
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });

    it('handles string and number inputs via BigInt conversion', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
          async (value) => {
            const fromNumber = satoshiToDecimalString(value);
            const fromString = satoshiToDecimalString(String(value));
            const fromBigInt = satoshiToDecimalString(BigInt(value));
            expect(fromNumber).to.equal(fromBigInt);
            expect(fromString).to.equal(fromBigInt);
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });

    it('throws for non-convertible inputs', function () {
      const badInputs = [undefined, null, NaN, Infinity, -Infinity, 'abc', '', '12.5', {}];
      for (const bad of badInputs) {
        try {
          satoshiToDecimalString(bad);
          expect.fail(`Expected ${String(bad)} to throw`);
        } catch (e) {
          // Any error type is acceptable (TypeError, RangeError, SyntaxError, etc.)
          expect(e).to.be.an.instanceOf(Error);
        }
      }
    });
  });

  describe('balance oracle', function () {
    let tracker;

    beforeEach(async function () {
      tracker = await createTestTracker();
    });

    afterEach(async function () {
      await closeTracker(tracker);
    });

    it('balance equals sum of coinbase outputs for single-address chain', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 20 }),
          fc.integer({ min: 0, max: 9 }),
          fc.array(fc.bigInt({ min: 1n, max: 10000000000n }), { minLength: 1, maxLength: 20 }),
          async (blockCount, addrIdx, values) => {
            const t = await createTestTracker();
            try {
              const actualCount = Math.min(blockCount, values.length);
              let prevHash = '0'.repeat(64);
              let expectedBalance = 0n;

              for (let i = 0; i < actualCount; i++) {
                const value = values[i];
                const tx = makeTx({
                  ins: [makeCoinbaseInput()],
                  outs: [{ value, script: TEST_KEYS[addrIdx].script }]
                });
                const block = makeBlock(i, prevHash, [tx]);
                await processAndCommit(t, block);
                prevHash = block.hash;
                expectedBalance += value;
              }

              const info = await t.getBalanceInfo(TEST_KEYS[addrIdx].address);
              const expectedStr = satoshiToDecimalString(expectedBalance);
              expect(info.balances.confirmed).to.equal(expectedStr);
              expect(info.balances.pending).to.equal('0.00000000');
            } finally {
              await closeTracker(t);
            }
          }
        ),
        { numRuns: Math.min(FUZZ_RUNS, 100) }
      );
    });

    it('spending reduces balance by exact output value', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.bigInt({ min: 10000n, max: 10000000000n }),
          fc.bigInt({ min: 1n, max: 9999n }),
          fc.integer({ min: 0, max: 9 }),
          async (coinbaseValue, spendValue, addrIdx) => {
            // spendValue must be <= coinbaseValue
            const actualSpend = spendValue > coinbaseValue ? coinbaseValue : spendValue;
            const changeValue = coinbaseValue - actualSpend;
            const t = await createTestTracker();
            try {
              const coinbaseTx = makeTx({
                ins: [makeCoinbaseInput()],
                outs: [{ value: coinbaseValue, script: TEST_KEYS[addrIdx].script }]
              });
              const block0 = makeBlock(0, '0'.repeat(64), [coinbaseTx]);
              await processAndCommit(t, block0);

              let info = await t.getBalanceInfo(TEST_KEYS[addrIdx].address);
              expect(info.balances.confirmed).to.equal(satoshiToDecimalString(coinbaseValue));

              const otherAddr = (addrIdx + 1) % 10;
              const spendTx = makeTx({
                ins: [makeSpendInput(coinbaseTx._txid, 0)],
                outs: [
                  { value: actualSpend, script: TEST_KEYS[otherAddr].script },
                  { value: changeValue, script: TEST_KEYS[addrIdx].script }
                ]
              });
              const block1 = makeBlock(1, block0.hash, [makeCoinbaseTx((addrIdx + 2) % 10), spendTx]);
              await processAndCommit(t, block1);

              info = await t.getBalanceInfo(TEST_KEYS[addrIdx].address);
              expect(info.balances.confirmed).to.equal(satoshiToDecimalString(changeValue));

              const otherInfo = await t.getBalanceInfo(TEST_KEYS[otherAddr].address);
              expect(otherInfo.balances.confirmed).to.equal(satoshiToDecimalString(actualSpend));
            } finally {
              await closeTracker(t);
            }
          }
        ),
        { numRuns: Math.min(FUZZ_RUNS, 100) }
      );
    });

    it('address with no outputs returns zero balance', async function () {
      const info = await tracker.getBalanceInfo(TEST_KEYS[5].address);
      expect(info.balances.confirmed).to.equal('0.00000000');
      expect(info.balances.pending).to.equal('0.00000000');
      expect(info.utxos.confirmed).to.equal(0);
    });
  });
});
