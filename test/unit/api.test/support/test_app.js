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

const { timingSafeEqual } = require('crypto');
const assert = require('assert');
const sinon = require('sinon');
const supertest = require('supertest');
const { createApp } = require('../../../../src/api/startup.js');

const ADMIN_METHODS = new Set([
  'getbootstrap', 'getbootstrapstatus',
  'restorebootstrap', 'getbootstraprestorestatus',
  'get_input_from_key_pattern'
]);

const MAX_JSONRPC_BATCH = 20;

function keyEquals(provided, expected) {
  const a = Buffer.from(String(provided == null ? '' : provided));
  const b = Buffer.from(String(expected == null ? '' : expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

function installUnmatchedRouteLabel(app) {
  app.all('/*unmatched', (req, res, next) => next());
  return app;
}

async function getTestBalance(mockTracker, address) {
  const utxos = await mockTracker.getUtxosAddress(address);
  return utxos.reduce((total, utxo) => total + utxo.amount, 0);
}

function createTestApp(mockTracker, adminApiKey = '') {
  return createApp({
    tracker: mockTracker,
    UTXO_TRACKER_API_KEY: adminApiKey,
    ADMIN_METHODS,
    MAX_JSONRPC_BATCH,
    MAX_PAGE_LIMIT: 10000,
    CORS_ORIGIN: '*',
    UTXO_TRACKER_RATE_LIMIT_RPM: 500,
    UTXO_TRACKER_MAX_CONCURRENT_PROBES: 16,
    UTXO_TRACKER_MAX_CONCURRENT_REQUESTS: 100,
    COIN: 'TEST',
    NETWORK: 'regtest',
    DB_NAME: 'xchain-utxo-tracker-test',
    keyEquals,
    installUnmatchedRouteLabel,
    launchTracker: () => Promise.resolve(),
    getBalance: (address) => getTestBalance(mockTracker, address),
    jsonRpcMethods: {
      async getbootstrap() {
        if (mockTracker.onAdminExecuted) mockTracker.onAdminExecuted();
        return { task_id: 'stub' };
      }
    }
  });
}

function createMockTracker(sinon) {
  return {
    getUtxosAddress: sinon.stub(),
    getFirstSeen: sinon.stub(),
    getBalanceInfo: sinon.stub(),
    isSynced: sinon.stub().returns(true),
    isMempoolReconverged: sinon.stub().returns(true),
    latestKnownChainTip: 100,
    db: {
      getValuesFromKeyPattern: sinon.stub(),
      getLastBlockHeight: sinon.stub().resolves(100)
    }
  };
}

if (typeof describe === 'function') {
  describe('production app gate', function () {
    afterEach(function () {
      sinon.restore();
    });

    it('serves the production UTXO route', async function () {
      const tracker = createMockTracker(sinon);
      const utxos = [{ txid: 'abc', vout: 0 }];
      tracker.getUtxosAddress.resolves(utxos);

      const response = await supertest(createTestApp(tracker)).get('/utxos/address').expect(200);
      assert.deepStrictEqual(response.body, utxos);

      const freshness = { mempool_ready: true };
      const res = {
        set(name, value) {
          assert.strictEqual(response.headers[name.toLowerCase()], value);
        }
      };
      res.set('X-Mempool-Ready', String(freshness.mempool_ready));
    });
  });
}

module.exports = { createTestApp, createMockTracker, MAX_JSONRPC_BATCH };
