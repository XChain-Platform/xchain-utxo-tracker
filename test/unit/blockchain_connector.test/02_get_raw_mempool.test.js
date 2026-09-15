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

function registerRawMempoolTests() {
  describe('getRawMempool', function () {
    it('returns array of txids', async function () {
      const txids = ['aaa', 'bbb', 'ccc'];
      clientStub.resolves({ data: { result: txids } });
      const result = await connector.getRawMempool();
      expect(result).to.deep.equal(txids);
    });

    it('throws on null result', async function () {
      clientStub.resolves({ data: { result: null } });
      try {
        await connector.getRawMempool();
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.message).to.include('mempool');
      }
    });
  });
}

describe('BlockchainConnector', function () {
  registerConnectorHooks();
  registerRawMempoolTests();
});

