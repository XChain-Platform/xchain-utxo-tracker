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
const { createTestApp, createMockTracker } = require('./api.test/support/test_app');

let app;
let mockTracker;

function registerApiHooks() {
  beforeEach(function () {
    mockTracker = createMockTracker(sinon);
    app = createTestApp(mockTracker);
  });

  afterEach(function () {
    sinon.restore();
  });
}

function registerGetUtxosTests() {
  describe('GET /utxos/:address', function () {
    it('returns UTXO array', async function () {
      const utxos = [{ txid: 'abc', vout: 0, amount: 1.5, value: '150000000' }];
      mockTracker.getUtxosAddress.resolves(utxos);

      const res = await supertest(app).get('/utxos/someaddress').expect(200);
      expect(res.body).to.deep.equal(utxos);
      expect(mockTracker.getUtxosAddress.calledWith('someaddress')).to.be.true;
    });

    it('returns 500 on error', async function () {
      mockTracker.getUtxosAddress.rejects(new Error('db failure'));
      const res = await supertest(app).get('/utxos/bad').expect(500);
      expect(res.body.error).to.include('db failure');
    });
  });
}

function registerGetBalanceTests() {
  describe('GET /balance/:address', function () {
    it('returns balance as number', async function () {
      mockTracker.getUtxosAddress.resolves([
        { amount: 1.5 },
        { amount: 0.5 }
      ]);

      const res = await supertest(app).get('/balance/addr1').expect(200);
      expect(res.body).to.equal(2);
    });

    it('returns 0 for empty UTXOs', async function () {
      mockTracker.getUtxosAddress.resolves([]);
      const res = await supertest(app).get('/balance/empty').expect(200);
      expect(res.body).to.equal(0);
    });
  });
}

function registerGetInfoTests() {
  describe('GET /info/:address', function () {
    it('returns balance info object', async function () {
      const info = {
        address: 'addr1',
        type: 'p2pkh',
        balances: { confirmed: '1.00000000', pending: '0.00000000', received: '1.00000000' },
        utxos: { confirmed: 1, pending: 0 }
      };
      mockTracker.getBalanceInfo.resolves(info);

      const res = await supertest(app).get('/info/addr1').expect(200);
      // Additive mempool_ready field; all original fields preserved.
      expect(res.body).to.include({ address: 'addr1', type: 'p2pkh' });
      expect(res.body.balances).to.deep.equal(info.balances);
      expect(res.body.utxos).to.deep.equal(info.utxos);
      expect(res.body.mempool_ready).to.equal(true);
    });
  });
}

function registerReadyTests() {
  describe('mempool readiness signal', function () {
    it('sets X-Mempool-Ready: true on all three address endpoints when synced', async function () {
      mockTracker.isSynced.returns(true);
      mockTracker.getUtxosAddress.resolves([]);
      mockTracker.getBalanceInfo.resolves({ address: 'a', balances: {}, utxos: {} });

      const utxosRes = await supertest(app).get('/utxos/a').expect(200);
      const balanceRes = await supertest(app).get('/balance/a').expect(200);
      const infoRes = await supertest(app).get('/info/a').expect(200);

      expect(utxosRes.headers['x-mempool-ready']).to.equal('true');
      expect(balanceRes.headers['x-mempool-ready']).to.equal('true');
      expect(infoRes.headers['x-mempool-ready']).to.equal('true');
      expect(infoRes.body.mempool_ready).to.equal(true);
    });

    it('reports false while the tracker is still reconverging', async function () {
      mockTracker.isSynced.returns(false);
      mockTracker.getUtxosAddress.resolves([]);
      mockTracker.getBalanceInfo.resolves({ address: 'a', balances: {}, utxos: {} });

      const utxosRes = await supertest(app).get('/utxos/a').expect(200);
      const balanceRes = await supertest(app).get('/balance/a').expect(200);
      const infoRes = await supertest(app).get('/info/a').expect(200);

      expect(utxosRes.headers['x-mempool-ready']).to.equal('false');
      expect(balanceRes.headers['x-mempool-ready']).to.equal('false');
      expect(infoRes.headers['x-mempool-ready']).to.equal('false');
      expect(infoRes.body.mempool_ready).to.equal(false);
    });
  });
}

function registerReconvergingTests() {
  describe('mempool readiness signal', function () {
    it('floors readiness on an orphaned view even while isSynced() reports true', async function () {
      // Committed tip above the node's: the node reindexed or reset underneath
      // the tracker, so the raw catch-up flag is no longer the right answer and
      // the header must follow the floored verdict instead.
      mockTracker.getUtxosAddress.resolves([]);
      mockTracker.getBalanceInfo.resolves({ address: 'a', balances: {}, utxos: {} });
      mockTracker.db.getLastBlockHeight.resolves(120);
      mockTracker.latestKnownChainTip = 100;

      const utxosRes = await supertest(app).get('/utxos/a').expect(200);
      const infoRes = await supertest(app).get('/info/a').expect(200);

      expect(utxosRes.headers['x-synced']).to.equal('false');
      expect(utxosRes.headers['x-mempool-ready']).to.equal('false');
      expect(infoRes.body.mempool_ready).to.equal(false);
    });

    it('evaluates readiness per request (not cached at startup)', async function () {
      mockTracker.getUtxosAddress.resolves([]);

      mockTracker.isSynced.returns(false);
      let res = await supertest(app).get('/utxos/a').expect(200);
      expect(res.headers['x-mempool-ready']).to.equal('false');

      mockTracker.isSynced.returns(true);
      res = await supertest(app).get('/utxos/a').expect(200);
      expect(res.headers['x-mempool-ready']).to.equal('true');
    });
  });
}

function registerGetFirstSeenTests() {
  describe('GET /firstseen/:address', function () {
    it('returns first-seen height', async function () {
      const firstSeen = { height: 100 };
      mockTracker.getFirstSeen.resolves(firstSeen);

      const res = await supertest(app).get('/firstseen/addr1').expect(200);
      expect(res.body).to.deep.equal(firstSeen);
    });

    it('returns null for unknown address', async function () {
      mockTracker.getFirstSeen.resolves(null);
      const res = await supertest(app).get('/firstseen/unknown').expect(200);
      expect(res.body).to.be.null;
    });
  });
}

describe('API', function () {
  registerApiHooks();
  registerGetUtxosTests();
  registerGetBalanceTests();
  registerGetInfoTests();
  registerReadyTests();
  registerReconvergingTests();
  registerGetFirstSeenTests();
});
