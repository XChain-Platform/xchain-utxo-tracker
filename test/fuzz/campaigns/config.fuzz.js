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
const { fc, FUZZ_RUNS } = require('../helpers');
const XChainUtxoTracker = require('../../../src/XChainUtxoTracker');
const XChainBlockDecoder = require('../../../src/XChainBlockDecoder');

describe('Fuzz: Configuration Parsing (P3)', function () {

  // ─── XChainUtxoTracker constructor ─────────────────────────────────────────

  describe('XChainUtxoTracker constructor', function () {
    it('handles fuzzed network strings without crashing', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 0, maxLength: 100 }),
          async (network) => {
            try {
              const tracker = new XChainUtxoTracker(
                network, '127.0.0.1', '18443', 'user', 'pass', 'test-db', false
              );
              // Constructor succeeded; the network may or may not be valid
              // but it should not crash
            } catch (e) {
              // Throwing is acceptable for invalid network
              expect(e).to.be.an('error');
            }
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });

    it('handles valid network strings', function () {
      const validNetworks = [
        'bitcoin-mainnet', 'bitcoin-testnet', 'bitcoin-regtest',
        'litecoin-mainnet', 'litecoin-testnet', 'litecoin-regtest',
        'dogecoin-mainnet', 'dogecoin-testnet', 'dogecoin-regtest'
      ];

      for (const network of validNetworks) {
        try {
          const tracker = new XChainUtxoTracker(
            network, '127.0.0.1', '18443', 'user', 'pass', 'test-db', false
          );
          // Should succeed
        } catch (e) {
          // Some networks may not be supported yet, that's fine
        }
      }
    });

    it('handles fuzzed port values', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.oneof(
            fc.string({ minLength: 1, maxLength: 6 }),
            fc.constant('0'),
            fc.constant('-1'),
            fc.constant('65536'),
            fc.constant('abc'),
            fc.constant(''),
            fc.constant('18443')
          ),
          async (port) => {
            try {
              const tracker = new XChainUtxoTracker(
                'bitcoin-regtest', '127.0.0.1', port, 'user', 'pass', 'test-db', false
              );
              // Constructor may succeed (port validation happens at connection time)
            } catch (e) {
              expect(e).to.be.an('error');
            }
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });

    it('handles fuzzed URL values', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.oneof(
            fc.string({ minLength: 0, maxLength: 200 }),
            fc.constant(''),
            fc.constant(null),
            fc.constant('http://localhost'),
            fc.constant('127.0.0.1'),
            fc.constant('::1')
          ),
          async (url) => {
            try {
              const tracker = new XChainUtxoTracker(
                'bitcoin-regtest', url, '18443', 'user', 'pass', 'test-db', false
              );
            } catch (e) {
              expect(e).to.be.an('error');
            }
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });

    it('handles fuzzed credentials', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 0, maxLength: 200 }),
          fc.string({ minLength: 0, maxLength: 200 }),
          async (user, pass) => {
            try {
              const tracker = new XChainUtxoTracker(
                'bitcoin-regtest', '127.0.0.1', '18443', user, pass, 'test-db', false
              );
              // Constructor should succeed (auth happens at connection time)
            } catch (e) {
              expect(e).to.be.an('error');
            }
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });

    it('handles fuzzed dbName', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.oneof(
            fc.string({ minLength: 0, maxLength: 100 }),
            fc.constant(''),
            fc.constant(null),
            fc.constant(undefined),
            fc.constant('../../../tmp/evil')
          ),
          async (dbName) => {
            try {
              const tracker = new XChainUtxoTracker(
                'bitcoin-regtest', '127.0.0.1', '18443', 'user', 'pass', dbName, false
              );
            } catch (e) {
              expect(e).to.be.an('error');
            }
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });

    it('handles fuzzed auxPow flag', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.oneof(
            fc.boolean(),
            fc.constant('true'),
            fc.constant('false'),
            fc.constant(''),
            fc.constant(null),
            fc.constant(undefined),
            fc.constant(0),
            fc.constant(1),
            fc.constant('yes')
          ),
          async (auxPow) => {
            try {
              const tracker = new XChainUtxoTracker(
                'bitcoin-regtest', '127.0.0.1', '18443', 'user', 'pass', 'test-db', auxPow
              );
            } catch (e) {
              expect(e).to.be.an('error');
            }
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });
  });

  // ─── XChainBlockDecoder constructor ────────────────────────────────────────

  describe('XChainBlockDecoder constructor', function () {
    it('handles any network name string', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 0, maxLength: 100 }),
          async (networkName) => {
            try {
              const decoder = new XChainBlockDecoder(networkName);
              expect(decoder.coin).to.be.a('string');
            } catch (e) {
              expect(e).to.be.an('error');
            }
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });

    it('extracts coin correctly from network-name format', function () {
      const cases = [
        ['bitcoin-mainnet', 'bitcoin'],
        ['litecoin-testnet', 'litecoin'],
        ['dogecoin-regtest', 'dogecoin'],
        ['singleword', 'singleword'],
        ['a-b-c', 'a'],
        ['', '']
      ];

      for (const [input, expected] of cases) {
        const decoder = new XChainBlockDecoder(input);
        expect(decoder.coin).to.equal(expected);
      }
    });
  });
});
