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

const { expect } = require('chai');
const {
  fc, FUZZ_RUNS, TEST_KEYS, SATOSHI,
  createTestTracker, closeTracker, randHash, randHash8,
  makeTx, makeCoinbaseTx, makeCoinbaseInput, makeSpendInput, makeBlock,
  processAndCommit
} = require('../helpers');
const { satoshiToDecimalString } = require('../../../src/XChainUtxoTracker');

describe('Fuzz: Mempool Operations (P2)', function () {

  // ─── Helper: process a tx into the mempool DB ─────────────────────────────
  // Mirrors the real updateMempool() flow: parseTransaction(mempoolDb, tx, null, -1, addHints=true)

  async function addToMempool(tracker, transaction) {
    const mdb = tracker.mempoolDb;
    await mdb.beginTransaction();
    await tracker.parseTransaction(mdb, transaction, null, -1, true);
    await mdb.endTransaction(true);
  }

  // ─── Mempool incoming outputs ──────────────────────────────────────────────

  describe('mempool incoming outputs', function () {
    it('pending balance reflects mempool incoming tx', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.bigInt({ min: 10000n, max: 10000000000n }),
          fc.bigInt({ min: 1000n, max: 5000000000n }),
          fc.integer({ min: 0, max: 4 }),
          async (confirmedValue, mempoolValue, addrIdx) => {
            const t = await createTestTracker();
            try {
              const otherIdx = (addrIdx + 1) % 10;

              // Confirmed: coinbase to addrIdx
              const coinbaseTx = makeTx({
                ins: [makeCoinbaseInput()],
                outs: [{ value: confirmedValue, script: TEST_KEYS[addrIdx].script }]
              });
              const block = makeBlock(0, '0'.repeat(64), [coinbaseTx]);
              await processAndCommit(t, block);

              // Mempool: someone creates output to otherIdx
              const mempoolTx = makeTx({
                ins: [makeCoinbaseInput()],
                outs: [{ value: mempoolValue, script: TEST_KEYS[otherIdx].script }]
              });
              await addToMempool(t, mempoolTx);

              // addrIdx: only confirmed balance
              const info = await t.getBalanceInfo(TEST_KEYS[addrIdx].address);
              expect(info.balances.confirmed).to.equal(satoshiToDecimalString(confirmedValue));

              // otherIdx: only pending balance
              const otherInfo = await t.getBalanceInfo(TEST_KEYS[otherIdx].address);
              expect(otherInfo.balances.pending).to.equal(satoshiToDecimalString(mempoolValue));
              expect(otherInfo.balances.confirmed).to.equal('0.00000000');
              expect(otherInfo.utxos.pending).to.equal(1);
            } finally {
              await closeTracker(t);
            }
          }
        ),
        { numRuns: Math.min(FUZZ_RUNS, 100) }
      );
    });
  });

  // ─── Multiple mempool transactions ─────────────────────────────────────────

  describe('multiple mempool transactions', function () {
    it('multiple mempool outputs to same address sum correctly', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 2, max: 5 }),
          fc.integer({ min: 0, max: 9 }),
          async (txCount, addrIdx) => {
            const t = await createTestTracker();
            try {
              let expectedPending = 0n;

              for (let i = 0; i < txCount; i++) {
                const value = BigInt((i + 1) * 1000);
                const tx = makeTx({
                  ins: [makeCoinbaseInput()],
                  outs: [{ value, script: TEST_KEYS[addrIdx].script }]
                });
                await addToMempool(t, tx);
                expectedPending += value;
              }

              const info = await t.getBalanceInfo(TEST_KEYS[addrIdx].address);
              expect(info.balances.pending).to.equal(satoshiToDecimalString(expectedPending));
              expect(info.utxos.pending).to.equal(txCount);
            } finally {
              await closeTracker(t);
            }
          }
        ),
        { numRuns: Math.min(FUZZ_RUNS, 100) }
      );
    });
  });

  // ─── Mempool spend detection ───────────────────────────────────────────────

  describe('mempool spend detection', function () {
    it('confirmed output spent in mempool shows negative pending', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.bigInt({ min: 10000n, max: 10000000000n }),
          fc.integer({ min: 0, max: 4 }),
          async (value, addrIdx) => {
            const t = await createTestTracker();
            try {
              const otherIdx = (addrIdx + 1) % 10;

              // Confirmed output to addrIdx
              const coinbaseTx = makeTx({
                ins: [makeCoinbaseInput()],
                outs: [{ value, script: TEST_KEYS[addrIdx].script }]
              });
              const block = makeBlock(0, '0'.repeat(64), [coinbaseTx]);
              await processAndCommit(t, block);

              // Mempool: spend the confirmed output
              const spendTx = makeTx({
                ins: [makeSpendInput(coinbaseTx._txid, 0)],
                outs: [{ value, script: TEST_KEYS[otherIdx].script }]
              });
              await addToMempool(t, spendTx);

              // getInput with full txid now works (truncated internally to match stored key)
              const inputByFullTxid = await t.mempoolDb.getInput(coinbaseTx._txid, 0);
              expect(inputByFullTxid).to.not.be.null;

              // getInput with txHash8 also works
              const txHash8 = coinbaseTx._txid.substring(0, 16);
              const inputByTxHash8 = await t.mempoolDb.getInput(txHash8, 0);
              expect(inputByTxHash8).to.not.be.null;

              // addrIdx: confirmed stays, pending shows negative (being spent)
              const info = await t.getBalanceInfo(TEST_KEYS[addrIdx].address);
              expect(info.balances.confirmed).to.equal(satoshiToDecimalString(value));
              expect(info.balances.pending).to.equal(satoshiToDecimalString(-value));
            } finally {
              await closeTracker(t);
            }
          }
        ),
        { numRuns: Math.min(FUZZ_RUNS, 50) }
      );
    });

    it('confirmed output spent in mempool is excluded from UTXO list', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.bigInt({ min: 10000n, max: 10000000000n }),
          fc.integer({ min: 0, max: 4 }),
          async (value, addrIdx) => {
            const t = await createTestTracker();
            try {
              const otherIdx = (addrIdx + 1) % 10;

              // Confirmed output
              const coinbaseTx = makeTx({
                ins: [makeCoinbaseInput()],
                outs: [{ value, script: TEST_KEYS[addrIdx].script }]
              });
              const block = makeBlock(0, '0'.repeat(64), [coinbaseTx]);
              await processAndCommit(t, block);

              // Spend in mempool
              const spendTx = makeTx({
                ins: [makeSpendInput(coinbaseTx._txid, 0)],
                outs: [{ value, script: TEST_KEYS[otherIdx].script }]
              });
              await addToMempool(t, spendTx);

              // UTXO list for addrIdx should be empty (output is being spent)
              const utxos = await t.getUtxosAddress(TEST_KEYS[addrIdx].address);
              expect(utxos.length).to.equal(0);

              // otherIdx should have the mempool UTXO
              const otherUtxos = await t.getUtxosAddress(TEST_KEYS[otherIdx].address);
              expect(otherUtxos.length).to.equal(1);
              expect(otherUtxos[0].confirmations).to.equal(0);
            } finally {
              await closeTracker(t);
            }
          }
        ),
        { numRuns: Math.min(FUZZ_RUNS, 50) }
      );
    });
  });

  // ─── Mempool output queries ────────────────────────────────────────────────

  describe('mempool output queries', function () {
    it('mempool outputs appear in UTXO list with 0 confirmations', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.bigInt({ min: 10000n, max: 10000000000n }),
          fc.integer({ min: 0, max: 9 }),
          async (value, addrIdx) => {
            const t = await createTestTracker();
            try {
              const tx = makeTx({
                ins: [makeCoinbaseInput()],
                outs: [{ value, script: TEST_KEYS[addrIdx].script }]
              });
              await addToMempool(t, tx);

              const utxos = await t.getUtxosAddress(TEST_KEYS[addrIdx].address);
              expect(utxos.length).to.equal(1);
              expect(utxos[0].confirmations).to.equal(0);
              expect(utxos[0].height).to.be.null;
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
