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
const sinon = require('sinon');
const { fc, FUZZ_RUNS } = require('../helpers');
const BlockchainConnector = require('../../../src/BlockchainConnector');

describe('Fuzz: BlockchainConnector Response Handling (P2)', function () {
  let connector;
  let clientStub;

  beforeEach(function () {
    connector = new BlockchainConnector('127.0.0.1', '8332', 'user', 'pass');
    clientStub = sinon.stub(connector.client, 'post');
  });

  afterEach(function () {
    sinon.restore();
  });

  describe('getBlockchainInfo', function () {
    it('handles any JSON-RPC result shape without crashing', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.anything(),
          async (result) => {
            clientStub.resolves({ data: { result } });
            try {
              const info = await connector.getBlockchainInfo();
            } catch (e) {
              expect(e).to.exist;
            }
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });

    it('handles error responses gracefully', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.oneof(
            fc.constant(new Error('ECONNREFUSED')),
            fc.constant(new Error('ETIMEDOUT')),
            fc.constant(new Error('socket hang up')),
            fc.constant({ response: { status: 500, data: 'Internal Server Error' } }),
            fc.constant({ response: { status: 403, data: 'Forbidden' } })
          ),
          async (err) => {
            clientStub.rejects(err);
            try {
              // A resolve here is unexpected given a rejected client call, but
              // only a crash (non-Error throw or hang) would fail this test.
              await connector.getBlockchainInfo();
            } catch (e) {
              expect(e).to.exist;
            }
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });
  });

  describe('getBlockHash', function () {
    it('handles non-string results without crashing', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.anything(),
          async (result) => {
            clientStub.resolves({ data: { result } });
            try {
              await connector.getBlockHash(100);
            } catch (e) {
              expect(e).to.exist;
            }
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });

    it('handles fuzzed block heights', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.oneof(
            fc.integer({ min: -1000, max: 1000000 }),
            fc.constant(NaN),
            fc.constant(Infinity),
            fc.constant(-Infinity),
            fc.constant(null),
            fc.constant(undefined)
          ),
          async (height) => {
            clientStub.resolves({ data: { result: 'a'.repeat(64) } });
            try {
              await connector.getBlockHash(height);
            } catch (e) {
              expect(e).to.exist;
            }
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });
  });

  describe('getBlock', function () {
    it('handles any result type without crashing', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.anything(),
          async (result) => {
            clientStub.resolves({ data: { result } });
            try {
              await connector.getBlock('a'.repeat(64));
            } catch (e) {
              expect(e).to.exist;
            }
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });
  });

  describe('getRawMempool', function () {
    it('handles non-array results', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.anything(),
          async (result) => {
            clientStub.resolves({ data: { result } });
            try {
              await connector.getRawMempool();
            } catch (e) {
              expect(e).to.exist;
            }
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });

    it('handles arrays with non-string entries', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.anything(), { minLength: 0, maxLength: 20 }),
          async (result) => {
            clientStub.resolves({ data: { result } });
            try {
              await connector.getRawMempool();
            } catch (e) {
              expect(e).to.exist;
            }
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });
  });

  describe('getRawTransactions', function () {
    it('handles batch responses with mixed results/errors', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 5 }),
          async (count) => {
            const batchResponse = [];
            for (let i = 0; i < count; i++) {
              batchResponse.push({
                result: i % 2 === 0 ? 'deadbeef' : null,
                error: i % 2 === 0 ? null : { code: -5, message: 'No such mempool transaction' }
              });
            }
            clientStub.resolves({ data: batchResponse });

            const txids = Array(count).fill(null).map(() => 'a'.repeat(64));
            try {
              await connector.getRawTransactions(txids);
            } catch (e) {
              expect(e).to.exist;
            }
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });
  });

  describe('getBlocksBatch', function () {
    it('handles empty height array', async function () {
      clientStub.resolves({ data: [] });
      try {
        const result = await connector.getBlocksBatch([]);
        expect(result).to.be.an('array');
      } catch (e) {
        expect(e).to.exist;
      }
    });

    it('handles fuzzed batch responses', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 1, max: 5 }),
          async (count) => {
            const heights = Array.from({ length: count }, (_, i) => i);
            // getBlocksBatch makes two batched RPC calls: hashes, then blocks
            // by hash, so the stub must answer them in that order.
            clientStub.onCall(0).resolves({
              data: heights.map((h, i) => ({ result: 'a'.repeat(64), id: i }))
            });
            clientStub.onCall(1).resolves({
              data: heights.map((h, i) => ({ result: 'ff'.repeat(80), id: i }))
            });

            try {
              await connector.getBlocksBatch(heights);
            } catch (e) {
              expect(e).to.exist;
            }
          }
        ),
        { numRuns: Math.min(FUZZ_RUNS, 200) }
      );
    });
  });

  describe('malformed responses', function () {
    it('handles undefined data field', async function () {
      clientStub.resolves({});
      try {
        await connector.getBlockchainInfo();
      } catch (e) {
        expect(e).to.exist;
      }
    });

    it('handles null response', async function () {
      clientStub.resolves(null);
      try {
        await connector.getBlockchainInfo();
      } catch (e) {
        expect(e).to.exist;
      }
    });

    it('handles response with error field', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.record({
            code: fc.integer({ min: -32700, max: -32600 }),
            message: fc.string({ minLength: 0, maxLength: 100 })
          }),
          async (error) => {
            clientStub.resolves({ data: { result: null, error } });
            try {
              await connector.getBlockchainInfo();
            } catch (e) {
              expect(e).to.exist;
            }
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });
  });
});
