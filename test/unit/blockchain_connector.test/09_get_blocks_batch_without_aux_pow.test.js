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
const { buildAuxPowBlockHex, buildAuxPowBlockHexEx } = require('./support/auxpow_builders');

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

function registerBatchAuxPowSuccessTests() {
  describe('getBlocksBatchWithoutAuxPow', function () {
    it('returns empty array for empty heights', async function () {
      const result = await connector.getBlocksBatchWithoutAuxPow([]);
      expect(result).to.deep.equal([]);
      expect(clientStub.called).to.be.false;
    });

    it('fetches hash+header+block batches and strips AuxPoW bytes', async function () {
      const heights = [200, 201];
      // call 0: getblockhash batch
      clientStub.onCall(0).resolves({ data: heights.map((h, i) => ({ id: i, result: 'hash' + i })) });
      // call 1: getblockheader batch: index 0 header longer than 160 hex chars (AuxPoW), index 1 exactly 160
      clientStub.onCall(1).resolves({ data: [
        { id: 0, result: 'a'.repeat(200) },  // 40 extra hex chars of AuxPoW
        { id: 1, result: 'b'.repeat(160) }   // standard header, nothing to strip
      ]});
      // call 2: getblock batch
      clientStub.onCall(2).resolves({ data: [
        { id: 0, result: 'h'.repeat(160) + 'x'.repeat(40) + 'TX0' },
        { id: 1, result: 'h'.repeat(160) + 'TX1' }
      ]});

      const results = await connector.getBlocksBatchWithoutAuxPow(heights);
      expect(clientStub.callCount).to.equal(3);
      expect(results).to.have.length(2);
      // index 0: 40 auxpow hex chars removed → header(160) + 'TX0'
      expect(results[0]).to.deep.equal({ height: 200, hash: 'hash0', hex: 'h'.repeat(160) + 'TX0' });
      // index 1: nothing stripped
      expect(results[1]).to.deep.equal({ height: 201, hash: 'hash1', hex: 'h'.repeat(160) + 'TX1' });
    });
  });
}

function registerBatchAuxPowFailureTests() {
  describe('getBlocksBatchWithoutAuxPow', function () {
    it('throws when a hash batch entry is null', async function () {
      clientStub.onCall(0).resolves({ data: [{ id: 0, result: null }] });
      try {
        await connector.getBlocksBatchWithoutAuxPow([5]);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.message).to.include('block hash in batch');
      }
    });

    it('throws when a header batch entry is null', async function () {
      clientStub.onCall(0).resolves({ data: [{ id: 0, result: 'hash0' }] });
      clientStub.onCall(1).resolves({ data: [{ id: 0, result: null }] });
      try {
        await connector.getBlocksBatchWithoutAuxPow([5]);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.message).to.include('block header in batch');
      }
    });

    it('throws when a block batch entry is null', async function () {
      clientStub.onCall(0).resolves({ data: [{ id: 0, result: 'hash0' }] });
      clientStub.onCall(1).resolves({ data: [{ id: 0, result: 'h'.repeat(160) }] });
      clientStub.onCall(2).resolves({ data: [{ id: 0, result: null }] });
      try {
        await connector.getBlocksBatchWithoutAuxPow([5]);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.message).to.include('block in batch');
      }
    });

    it('strips AuxPoW by structural parse when getblockheader returns 160 chars but AuxPoW bit is set (Dogecoin Core 1.14)', async function () {
      // Mirrors the single-block test: header always 160 chars, strip from block hex.
      const txBodyHex = 'ff'.repeat(8)
      const fullBlockHex = buildAuxPowBlockHex(txBodyHex)
      const pureHeader = '0'.repeat(160)

      clientStub.onCall(0).resolves({ data: [{ id: 0, result: 'hash0' }] })
      clientStub.onCall(1).resolves({ data: [{ id: 0, result: pureHeader }] })
      clientStub.onCall(2).resolves({ data: [{ id: 0, result: fullBlockHex }] })

      const results = await connector.getBlocksBatchWithoutAuxPow([42])
      expect(results).to.have.length(1)
      expect(results[0].height).to.equal(42)
      expect(results[0].hex.substring(0, 160)).to.equal(fullBlockHex.substring(0, 160))
      expect(results[0].hex.substring(160)).to.equal(txBodyHex)
    });
  });
}

describe('BlockchainConnector', function () {
  registerConnectorHooks();
  registerBatchAuxPowSuccessTests();
  registerBatchAuxPowFailureTests();
});

