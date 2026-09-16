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

function registerRawTransactionsTests() {
  describe('getRawTransactions', function () {
    it('fetches all txids in parallel', async function () {
      clientStub.resolves({ data: { result: 'hexdata' } });
      const results = await connector.getRawTransactions(['tx1', 'tx2', 'tx3']);
      expect(results).to.have.length(3);
      expect(results.every(r => r === 'hexdata')).to.be.true;
    });

    it('returns empty array for empty input', async function () {
      const results = await connector.getRawTransactions([]);
      expect(results).to.be.empty;
    });
  });
}

describe('BlockchainConnector', function () {
  registerConnectorHooks();
  registerRawTransactionsTests();
});

