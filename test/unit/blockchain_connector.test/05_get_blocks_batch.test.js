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

const H100 = 'a1'.repeat(32);
const H101 = 'b2'.repeat(32);
const H102 = 'c3'.repeat(32);
const HASH_A = 'd4'.repeat(32);
const HASH_B = 'e5'.repeat(32);

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
      const hashes = [H100, H101, H102];

      // First call: batch getblockhash
      clientStub.onCall(0).resolves({
        data: heights.map((h, i) => ({ id: i, result: hashes[i] }))
      });

      // Second call: batch getblock
      clientStub.onCall(1).resolves({
        data: hashes.map((hash, i) => ({ id: i, result: '0' + i + 'ab' }))
      });

      const results = await connector.getBlocksBatch(heights);
      expect(clientStub.callCount).to.equal(2);
      expect(results).to.have.length(3);
      expect(results[0]).to.deep.equal({ height: 100, hash: H100, hex: '00ab' });
      expect(results[2]).to.deep.equal({ height: 102, hash: H102, hex: '02ab' });
    });

    it('handles out-of-order batch responses', async function () {
      clientStub.onCall(0).resolves({
        data: [
          { id: 1, result: HASH_B },
          { id: 0, result: HASH_A }
        ]
      });
      clientStub.onCall(1).resolves({
        data: [
          { id: 1, result: 'bbbb' },
          { id: 0, result: 'aaaa' }
        ]
      });

      const results = await connector.getBlocksBatch([10, 11]);
      expect(results[0].hash).to.equal(HASH_A);
      expect(results[1].hash).to.equal(HASH_B);
    });
  });
}

function registerFailedBatchTests() {
  describe('getBlocksBatch', function () {
    it('returns an uppercase getblockhash answer lowercased', async function () {
      clientStub.onCall(0).resolves({ data: [{ id: 0, result: H100.toUpperCase() }] });
      clientStub.onCall(1).resolves({ data: [{ id: 0, result: '00ab' }] });

      const results = await connector.getBlocksBatch([100]);
      expect(results[0].hash).to.equal(H100);
    });

    for (const [label, bad] of [['a short string', 'hash100'], ['a number', 12345], ['an object', { hash: H100 }],
      ['a non-hex 64-char string', 'g'.repeat(64)]]) {
      it('rejects ' + label + ' as a batch block hash with an untagged error before getblock', async function () {
        clientStub.onCall(0).resolves({ data: [{ id: 0, result: bad }] });

        let caught;
        try {
          await connector.getBlocksBatch([100]);
        } catch (err) {
          caught = err;
        }
        expect(caught, 'should have thrown').to.be.an('error');
        expect(caught.message).to.include('malformed result');
        expect(caught.auxPowParseFailure).to.equal(undefined);
        expect(clientStub.callCount).to.equal(1);
      });
    }

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
      clientStub.onCall(0).resolves({ data: [{ id: 0, result: H100 }] });
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

