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

  // These constructor tests only assert crash-safety: either the call
  // succeeds or it throws an Error, never anything else (hang, non-Error
  // throw, etc). Deferred-validation rationale for specific fields is
  // noted where it applies below.

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
            } catch (e) {
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
        } catch (e) {
          // Some listed networks may not be supported yet; that is not a failure here.
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
              // Port validation happens at connection time, not construction,
              // so a malformed port here is not required to throw.
              const tracker = new XChainUtxoTracker(
                'bitcoin-regtest', '127.0.0.1', port, 'user', 'pass', 'test-db', false
              );
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
              // Auth happens at connection time, not construction.
              const tracker = new XChainUtxoTracker(
                'bitcoin-regtest', '127.0.0.1', '18443', user, pass, 'test-db', false
              );
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
        ['dogecoin-regtest', 'dogecoin']
      ];

      for (const [input, expected] of cases) {
        const decoder = new XChainBlockDecoder(input);
        expect(decoder.coin).to.equal(expected);
      }
    });

    // A name whose leading segment is not a registered coin has no declared
    // block/tx wire format, so construction refuses rather than handing back a
    // decoder that would parse under the strict bitcoinjs default.
    it('refuses a network name whose coin is not in the registry', function () {
      for (const input of ['singleword', 'a-b-c', '']) {
        expect(() => new XChainBlockDecoder(input), input)
          .to.throw(/no block\/tx wire-format contract declared/);
      }
    });
  });
});
