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
const supertest = require('supertest');
const { createTestApp, createMockTracker } = require('./support/test_app');

let mockTracker;

function registerApiHooks() {
  beforeEach(function () {
    mockTracker = createMockTracker(sinon);
    createTestApp(mockTracker);
  });

  afterEach(function () {
    sinon.restore();
  });
}

// App created with a Bearer API key so admin-method auth is exercised.
// Public-method routes are unaffected by the extra header.
let rpcApp;

function registerRpcHooks() {
    beforeEach(function () {
      rpcApp = createTestApp(mockTracker, 'secret-key');
    });
}

function rpcRequest(method, params = {}) {
  return supertest(rpcApp)
    .post('/')
    .set('Authorization', 'Bearer secret-key')
    .send({ jsonrpc: '2.0', method, params, id: 1 })
    .set('Content-Type', 'application/json');
}

function registerPublicRpcTests() {
  describe('POST / (JSON-RPC)', function () {
    registerRpcHooks();
    it('ping returns success', async function () {
      const res = await rpcRequest('ping').expect(200);
      expect(res.body.result).to.deep.equal({ status: 'success' });
    });

    it('get_utxos returns utxo array', async function () {
      const utxos = [{ txid: 'abc', vout: 0 }];
      mockTracker.getUtxosAddress.resolves(utxos);

      const res = await rpcRequest('get_utxos', { address: 'addr1' }).expect(200);
      expect(res.body.result.utxos).to.deep.equal(utxos);
    });

    it('get_balance returns balance', async function () {
      mockTracker.getUtxosAddress.resolves([{ amount: 2.5 }]);
      const res = await rpcRequest('get_balance', { address: 'addr1' }).expect(200);
      expect(res.body.result.balance).to.equal(2.5);
    });

    it('get_info returns info object', async function () {
      const info = { address: 'a', balances: { confirmed: '1.00' } };
      mockTracker.getBalanceInfo.resolves(info);

      const res = await rpcRequest('get_info', { address: 'a' }).expect(200);
      expect(res.body.result.address).to.equal('a');
    });

    it('get_first_seen returns height', async function () {
      mockTracker.getFirstSeen.resolves({ height: 1 });
      const res = await rpcRequest('get_first_seen', { address: 'a' }).expect(200);
      expect(res.body.result.height).to.equal(1);
    });
  });
}

function registerPatternRpcTests() {
  describe('POST / (JSON-RPC)', function () {
    registerRpcHooks();
    it('get_input_from_key_pattern rejects short patterns', async function () {
      const res = await rpcRequest('get_input_from_key_pattern', { pattern: 'short' }).expect(200);
      expect(res.body.result.error).to.include('too short');
    });

    it('get_input_from_key_pattern rejects non-hex patterns of valid length', async function () {
      // Buffer.from silently truncates at the first non-hex char, so 32 'g's
      // would decode to an empty prefix (full-DB scan) without the hex gate.
      const res = await rpcRequest('get_input_from_key_pattern', { pattern: 'g'.repeat(32) }).expect(200);
      expect(res.body.result.error).to.include('hex');
      expect(mockTracker.db.getValuesFromKeyPattern.called).to.equal(false);
    });

    it('get_input_from_key_pattern returns results for valid pattern', async function () {
      mockTracker.db.getValuesFromKeyPattern.resolves([{ key: 'k1', value: 'v1' }]);

      const pattern = 'a'.repeat(32);
      const res = await rpcRequest('get_input_from_key_pattern', { pattern }).expect(200);
      expect(res.body.result.result).to.have.length(1);
    });

    it('returns error for unknown method', async function () {
      const res = await rpcRequest('nonexistent_method').expect(200);
      // express-json-rpc-router returns error for unknown methods
      expect(res.body.error).to.exist;
    });
  });
}

describe('API', function () {
  registerApiHooks();
  registerPublicRpcTests();
  registerPatternRpcTests();
});
