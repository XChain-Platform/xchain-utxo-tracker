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

function registerRawTransactionTests() {
  describe('getRawTransaction', function () {
    it('returns raw hex on success', async function () {
      clientStub.resolves({ data: { result: '020000000001...' } });
      const hex = await connector.getRawTransaction('txid123');
      expect(hex).to.equal('020000000001...');
    });

    it('retries on failure up to 10 times', async function () {
      // Stub sleep so the retry backoff resolves instantly, keeping the test fast.
      // Use a real short sleep to keep tests fast
      sinon.stub(connector, 'sleep').resolves();

      clientStub.rejects(new Error('timeout'));

      try {
        await connector.getRawTransaction('txid123');
        expect.fail('should have rejected');
      } catch (err) {
        // After 10 tries it rejects with an Error carrying the txid for context
        expect(clientStub.callCount).to.equal(10);
        expect(err).to.be.an.instanceof(Error);
        expect(err.message).to.contain('txid123');
      }
    });

    it('succeeds after transient failures', async function () {
      sinon.stub(connector, 'sleep').resolves();
      clientStub.onCall(0).rejects(new Error('timeout'));
      clientStub.onCall(1).rejects(new Error('timeout'));
      clientStub.onCall(2).resolves({ data: { result: 'hexdata' } });

      const result = await connector.getRawTransaction('txid');
      expect(result).to.equal('hexdata');
      expect(clientStub.callCount).to.equal(3);
    });
  });
}

describe('BlockchainConnector', function () {
  registerConnectorHooks();
  registerRawTransactionTests();
});

