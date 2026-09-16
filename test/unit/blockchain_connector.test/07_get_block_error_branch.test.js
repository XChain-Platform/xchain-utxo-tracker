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

function registerMissingBlockTest() {
  describe('getBlock (error branch)', function () {
    it('throws and rethrows when the node returns no result', async function () {
      clientStub.resolves({ data: {} }); // postWithRetry returns it; no .result
      try {
        await connector.getBlock('hashX');
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.message).to.include('block hex');
      }
    });
  });
}

describe('BlockchainConnector', function () {
  registerConnectorHooks();
  registerMissingBlockTest();
});

