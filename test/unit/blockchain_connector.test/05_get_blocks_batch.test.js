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
const BlockchainConnector = require('../../../src/chain/blockchain_connector');

let connector;
let clientStub;

function registerConnectorHooks() {
  beforeEach(function () {
    connector = new BlockchainConnector('127.0.0.1', '8332', 'user', 'pass');
    clientStub = sinon.stub(connector.client, 'post');
  });

  afterEach(function () {
    sinon.restore();
  });
}

function registerSuccessfulBatchTests() {
  describe('getBlocksBatch', function () {
    it('returns empty array for empty heights', async function () {
      const result = await connector.getBlocksBatch([]);
      expect(result).to.deep.equal([]);
      expect(clientStub.called).to.be.false;
    });

    it('issues exactly 2 HTTP calls for N heights', async function () {
      const heights = [100, 101, 102];
      const hashes = ['hash100', 'hash101', 'hash102'];

      // First call: batch getblockhash
      clientStub.onCall(0).resolves({
        data: heights.map((h, i) => ({ id: i, result: hashes[i] }))
      });

      // Second call: batch getblock
      clientStub.onCall(1).resolves({
        data: hashes.map((hash, i) => ({ id: i, result: 'hex' + i }))
      });

      const results = await connector.getBlocksBatch(heights);
      expect(clientStub.callCount).to.equal(2);
      expect(results).to.have.length(3);
      expect(results[0]).to.deep.equal({ height: 100, hash: 'hash100', hex: 'hex0' });
      expect(results[2]).to.deep.equal({ height: 102, hash: 'hash102', hex: 'hex2' });
    });

    it('handles out-of-order batch responses', async function () {
      clientStub.onCall(0).resolves({
        data: [
          { id: 1, result: 'hash_b' },
          { id: 0, result: 'hash_a' }
        ]
      });
      clientStub.onCall(1).resolves({
        data: [
          { id: 1, result: 'hex_b' },
          { id: 0, result: 'hex_a' }
        ]
      });

      const results = await connector.getBlocksBatch([10, 11]);
      expect(results[0].hash).to.equal('hash_a');
      expect(results[1].hash).to.equal('hash_b');
    });
  });
}

function registerFailedBatchTests() {
  describe('getBlocksBatch', function () {
    it('throws when a hash in batch is null', async function () {
      clientStub.onCall(0).resolves({
        data: [{ id: 0, result: null }]
      });

      try {
        await connector.getBlocksBatch([100]);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.message).to.include('batch');
      }
    });

    it('throws when a block result in batch is null', async function () {
      // Hash batch succeeds, block batch returns a null result for one entry.
      clientStub.onCall(0).resolves({ data: [{ id: 0, result: 'hash0' }] });
      clientStub.onCall(1).resolves({ data: [{ id: 0, result: null }] });

      try {
        await connector.getBlocksBatch([100]);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.message).to.include('block in batch');
      }
    });
  });
}

describe('BlockchainConnector', function () {
  registerConnectorHooks();
  registerSuccessfulBatchTests();
  registerFailedBatchTests();
});

