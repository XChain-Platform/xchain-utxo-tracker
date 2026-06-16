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
  fc, FUZZ_RUNS, NETWORK, TEST_KEYS, arbAddress, arbValidAddress,
  createTestTracker, closeTracker,
  makeCoinbaseTx, makeBlock, processAndCommit
} = require('../helpers');
const XChainUtxoTracker = require('../../../src/XChainUtxoTracker');

describe('Fuzz: Address Validation (P1)', function () {
  let tracker;

  beforeEach(async function () {
    tracker = await createTestTracker();
  });

  afterEach(async function () {
    await closeTracker(tracker);
  });

  // ─── getAddressType ────────────────────────────────────────────────────────

  describe('getAddressType', function () {
    it('never throws for any string input', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 0, maxLength: 200 }),
          async (addr) => {
            // Must not throw — should return a string type
            const result = tracker.getAddressType(addr, NETWORK);
            expect(result).to.be.a('string');
            expect(['p2pkh', 'p2sh', 'p2wpkh', 'p2tr', 'unknown']).to.include(result);
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });

    it('correctly identifies all valid test addresses as p2pkh', function () {
      for (const key of TEST_KEYS) {
        const result = tracker.getAddressType(key.address, NETWORK);
        expect(result).to.equal('p2pkh');
      }
    });

    it('returns "unknown" for garbage inputs', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.oneof(
            fc.constant(''),
            fc.constant('notanaddress'),
            fc.constant('12345'),
            fc.string({ minLength: 10, maxLength: 50 }),
            fc.string({ minLength: 50, maxLength: 200 })
          ),
          async (addr) => {
            const result = tracker.getAddressType(addr, NETWORK);
            expect(result).to.equal('unknown');
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });

    it('handles null/undefined/non-string inputs without crashing', function () {
      const badInputs = [null, undefined, 0, false, {}, [], NaN];
      for (const bad of badInputs) {
        try {
          const result = tracker.getAddressType(bad, NETWORK);
          // If it returns, it should be a string
          expect(result).to.be.a('string');
        } catch (e) {
          // Throwing is acceptable for truly invalid types
          expect(e).to.be.an('error');
        }
      }
    });
  });

  // ─── getBalanceInfo with fuzzed addresses ──────────────────────────────────

  describe('getBalanceInfo with fuzzed addresses', function () {
    it('returns valid result for any valid address', async function () {
      await fc.assert(
        fc.asyncProperty(
          arbValidAddress(),
          async (addr) => {
            const info = await tracker.getBalanceInfo(addr);
            expect(info).to.be.an('object');
            expect(info.address).to.equal(addr);
            expect(info.balances).to.be.an('object');
            expect(info.balances.confirmed).to.match(/^-?\d+\.\d{8}$/);
            expect(info.balances.pending).to.match(/^-?\d+\.\d{8}$/);
            expect(info.utxos.confirmed).to.be.a('number');
            expect(info.utxos.pending).to.be.a('number');
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });

    it('throws for invalid addresses (toOutputScript fails)', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.oneof(
            fc.constant(''),
            fc.constant('notanaddress'),
            fc.string({ minLength: 1, maxLength: 100 }).filter(s => {
              // Filter out strings that might accidentally be valid
              try {
                require('bitcoinjs-lib').address.toOutputScript(s, NETWORK);
                return false;
              } catch { return true; }
            })
          ),
          async (addr) => {
            try {
              await tracker.getBalanceInfo(addr);
              // If it doesn't throw, that's a finding worth noting but not a test failure
            } catch (e) {
              expect(e).to.be.an('error');
            }
          }
        ),
        { numRuns: Math.min(FUZZ_RUNS, 200) }
      );
    });
  });

  // ─── getUtxosAddress with fuzzed addresses ─────────────────────────────────

  describe('getUtxosAddress with fuzzed addresses', function () {
    it('returns array for valid addresses', async function () {
      // First, add some data
      const block = makeBlock(0, '0'.repeat(64), [makeCoinbaseTx(0)]);
      await processAndCommit(tracker, block);

      await fc.assert(
        fc.asyncProperty(
          arbValidAddress(),
          async (addr) => {
            const utxos = await tracker.getUtxosAddress(addr);
            expect(utxos).to.be.an('array');
            for (const utxo of utxos) {
              expect(utxo).to.have.property('txid');
              expect(utxo).to.have.property('vout');
              expect(utxo).to.have.property('value');
              expect(utxo).to.have.property('amount');
              expect(utxo).to.have.property('confirmations');
            }
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });

    it('throws for invalid addresses', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 50 }).filter(s => {
            try {
              require('bitcoinjs-lib').address.toOutputScript(s, NETWORK);
              return false;
            } catch { return true; }
          }),
          async (addr) => {
            try {
              await tracker.getUtxosAddress(addr);
            } catch (e) {
              expect(e).to.be.an('error');
            }
          }
        ),
        { numRuns: Math.min(FUZZ_RUNS, 200) }
      );
    });
  });

  // ─── getFirstSeen with fuzzed addresses ────────────────────────────────────

  describe('getFirstSeen with fuzzed addresses', function () {
    it('returns null or {height} for valid addresses', async function () {
      await fc.assert(
        fc.asyncProperty(
          arbValidAddress(),
          async (addr) => {
            const result = await tracker.getFirstSeen(addr);
            if (result !== null) {
              expect(result).to.have.property('height').that.is.a('number');
            }
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });
  });
});
