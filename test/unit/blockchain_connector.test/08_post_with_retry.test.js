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

function registerPostWithRetryTests() {
  describe('postWithRetry', function () {
    it('retries on ECONNABORTED then succeeds', async function () {
      sinon.stub(connector, 'sleep').resolves();
      clientStub.onCall(0).rejects({ code: 'ECONNABORTED' });
      clientStub.onCall(1).resolves({ data: { result: 'ok' } });
      const res = await connector.postWithRetry({ method: 'x' });
      expect(res.data.result).to.equal('ok');
      expect(clientStub.callCount).to.equal(2);
    });

    it('rethrows a non-timeout error immediately', async function () {
      clientStub.rejects(new Error('connection refused'));
      try {
        await connector.postWithRetry({ method: 'x' });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.message).to.include('connection refused');
        expect(clientStub.callCount).to.equal(1);
      }
    });

    it('throws after exhausting the 10 timeout retries', async function () {
      sinon.stub(connector, 'sleep').resolves();
      clientStub.rejects({ code: 'ECONNABORTED' });
      try {
        await connector.postWithRetry({ method: 'x' });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.message).to.include('after retries');
        expect(clientStub.callCount).to.equal(10);
      }
    });
  });
}

describe('BlockchainConnector', function () {
  registerConnectorHooks();
  registerPostWithRetryTests();
});

