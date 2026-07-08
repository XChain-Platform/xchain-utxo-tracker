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
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const helmet = require('helmet');
const supertest = require('supertest');
const { timingSafeEqual } = require('crypto');
const XChainUtxoTracker = require('../../src/XChainUtxoTracker');

// Mirror of src/api.js keyEquals: length-guarded constant-time comparison.
function keyEquals(provided, expected) {
  const a = Buffer.from(String(provided == null ? '' : provided));
  const b = Buffer.from(String(expected == null ? '' : expected));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// We can't import api.js directly (it calls startApi and hits real env vars).
// Instead, we construct the Express app with mocked tracker.
//
// adminApiKey (optional) mirrors api.js's admin-method auth middleware so the
// batch-bypass regression can be exercised. ADMIN_METHODS is kept in sync with
// api.js's set of privileged JSON-RPC methods.
const ADMIN_METHODS = new Set([
  'getbootstrap', 'getbootstrapstatus',
  'restorebootstrap', 'getbootstraprestorestatus',
  'get_input_from_key_pattern'
]);

function createTestApp(mockTracker, adminApiKey = '') {
  const app = express();
  app.use(helmet());
  app.use(bodyParser.json());
  app.use(cors());

  // Same guard as src/api.js: gate the whole request when ANY entry (single or
  // batch) names an admin method. Fails closed when no key is configured.
  app.use((req, res, next) => {
    const body = req.body;
    const entries = Array.isArray(body) ? body : [body];
    const wantsAdmin = entries.some(e =>
      e && typeof e.method === 'string' && ADMIN_METHODS.has(e.method.toLowerCase()));
    if (wantsAdmin) {
      const header = req.headers['authorization'];
      if (!adminApiKey || !header || !keyEquals(header, 'Bearer ' + adminApiKey)) {
        return res.status(401).json({
          jsonrpc: '2.0', id: (!Array.isArray(body) && body && body.id) || null,
          error: { code: -32001, message: 'Unauthorized' }
        });
      }
    }
    next();
  });

  async function getUtxos(address) {
    return mockTracker.getUtxosAddress(address);
  }
  async function getFirstSeen(address) {
    return mockTracker.getFirstSeen(address);
  }
  async function getBalance(address) {
    const utxos = await mockTracker.getUtxosAddress(address);
    let balance = 0;
    for (const u of utxos) balance += u.amount;
    return balance;
  }
  async function getInfo(address) {
    return mockTracker.getBalanceInfo(address);
  }

  app.get('/utxos/:address', async (req, res) => {
    try {
      const utxos = await getUtxos(req.params.address);
      res.set('X-Mempool-Ready', String(mockTracker.isSynced()));
      res.json(utxos);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/firstseen/:address', async (req, res) => {
    try {
      const result = await getFirstSeen(req.params.address);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/balance/:address', async (req, res) => {
    try {
      const balance = await getBalance(req.params.address);
      res.set('X-Mempool-Ready', String(mockTracker.isSynced()));
      res.json(balance);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/info/:address', async (req, res) => {
    try {
      const info = await getInfo(req.params.address);
      const mempoolReady = mockTracker.isSynced();
      res.set('X-Mempool-Ready', String(mempoolReady));
      if (info && typeof info === 'object') info.mempool_ready = mempoolReady;
      res.json(info);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // JSON-RPC via POST
  const jsonRouter = require('express-json-rpc-router');

  const jsonRpcController = {
    async ping() {
      return { status: 'success' };
    },
    async get_utxos({ address }) {
      const utxos = await getUtxos(address);
      return { utxos };
    },
    async get_first_seen({ address }) {
      return await getFirstSeen(address);
    },
    async get_balance({ address }) {
      const balance = await getBalance(address);
      return { balance };
    },
    async get_info({ address }) {
      const info = await getInfo(address);
      return info;
    },
    async get_input_from_key_pattern({ pattern }) {
      if (typeof pattern !== 'string' || pattern.length < 32) {
        return { error: 'pattern is too short' };
      }
      if (!/^[0-9a-fA-F]+$/.test(pattern)) {
        return { error: 'pattern must be a hex string' };
      }
      const results = await mockTracker.db.getValuesFromKeyPattern(pattern,
        { maxValues: XChainUtxoTracker.MAX_ADDRESS_OUTPUTS });
      return { result: results };
    },
    // Stand-in for the destructive bootstrap RPC; records execution so tests can
    // assert the auth gate blocks it before the controller ever runs.
    async getbootstrap() {
      if (mockTracker.onAdminExecuted) mockTracker.onAdminExecuted();
      return { task_id: 'stub' };
    }
  };

  app.use(jsonRouter({ methods: jsonRpcController }));

  return app;
}

describe('API', function () {
  let app;
  let mockTracker;

  beforeEach(function () {
    mockTracker = {
      getUtxosAddress: sinon.stub(),
      getFirstSeen: sinon.stub(),
      getBalanceInfo: sinon.stub(),
      isSynced: sinon.stub().returns(true),
      db: {
        getValuesFromKeyPattern: sinon.stub()
      }
    };
    app = createTestApp(mockTracker);
  });

  afterEach(function () {
    sinon.restore();
  });

  // ─── REST Endpoints ──────────────────────────────────────────────────

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

  // ─── Mempool readiness signal ───────────────────────────────────────────
  // After a restart the in-memory mempool is empty until the first
  // updateMempool() scan completes; these endpoints expose isSynced() so
  // callers can tell a reconverging zero from a genuine zero.

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

  // ─── JSON-RPC ────────────────────────────────────────────────────────

  describe('POST / (JSON-RPC)', function () {
    // get_input_from_key_pattern is an admin method, so this block runs against
    // an authenticated app and rpcRequest sends the Bearer key. Public methods
    // in the block are unaffected by the extra header.
    let rpcApp;
    beforeEach(function () {
      rpcApp = createTestApp(mockTracker, 'secret-key');
    });
    function rpcRequest(method, params = {}) {
      return supertest(rpcApp)
        .post('/')
        .set('Authorization', 'Bearer secret-key')
        .send({ jsonrpc: '2.0', method, params, id: 1 })
        .set('Content-Type', 'application/json');
    }

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

  // ─── Admin-method authentication ─────────────────────────────────────────
  // Admin JSON-RPC methods (bootstrap snapshot/restore, raw key scans) must be
  // gated by the API key. The router executes JSON-RPC batches (array bodies)
  // too, so the guard must inspect every entry, not just req.body.method.
  // Regression: a batch [{"method":"getbootstrap"}] previously bypassed the
  // key check entirely because req.body.method is undefined for an array.

  describe('admin-method auth', function () {
    let adminApp;

    beforeEach(function () {
      mockTracker.onAdminExecuted = sinon.stub();
      mockTracker.db.getValuesFromKeyPattern = sinon.stub().resolves([]);
      adminApp = createTestApp(mockTracker, 'secret-key');
    });

    it('rejects a single admin request with no key (401)', async function () {
      const res = await supertest(adminApp)
        .post('/')
        .send({ jsonrpc: '2.0', method: 'getbootstrap', params: {}, id: 1 })
        .expect(401);
      expect(res.body.error.message).to.equal('Unauthorized');
      expect(mockTracker.onAdminExecuted.called).to.equal(false);
    });

    it('rejects an admin method smuggled inside a BATCH with no key (401)', async function () {
      const res = await supertest(adminApp)
        .post('/')
        .send([{ jsonrpc: '2.0', method: 'getbootstrap', params: {}, id: 1 }])
        .expect(401);
      expect(res.body.error.message).to.equal('Unauthorized');
      // The controller must never run: the gate short-circuits before the router.
      expect(mockTracker.onAdminExecuted.called).to.equal(false);
    });

    it('rejects an admin method mixed with a public method in a batch (401)', async function () {
      const res = await supertest(adminApp)
        .post('/')
        .send([
          { jsonrpc: '2.0', method: 'ping', id: 1 },
          { jsonrpc: '2.0', method: 'getbootstrap', params: {}, id: 2 }
        ])
        .expect(401);
      expect(res.body.error.message).to.equal('Unauthorized');
      expect(mockTracker.onAdminExecuted.called).to.equal(false);
    });

    it('allows an admin batch with the correct Bearer key', async function () {
      const res = await supertest(adminApp)
        .post('/')
        .set('Authorization', 'Bearer secret-key')
        .send([{ jsonrpc: '2.0', method: 'getbootstrap', params: {}, id: 1 }])
        .expect(200);
      expect(res.body[0].result).to.deep.equal({ task_id: 'stub' });
      expect(mockTracker.onAdminExecuted.calledOnce).to.equal(true);
    });

    it('still allows public methods in a batch with no key', async function () {
      const res = await supertest(adminApp)
        .post('/')
        .send([{ jsonrpc: '2.0', method: 'ping', id: 1 }])
        .expect(200);
      expect(res.body[0].result).to.deep.equal({ status: 'success' });
    });
  });

  // ─── Middleware ─────────────────────────────────────────────────────────

  describe('middleware', function () {
    it('includes CORS headers', async function () {
      mockTracker.getUtxosAddress.resolves([]);
      const res = await supertest(app).get('/utxos/test');
      expect(res.headers['access-control-allow-origin']).to.exist;
    });

    it('includes security headers from helmet', async function () {
      mockTracker.getUtxosAddress.resolves([]);
      const res = await supertest(app).get('/utxos/test');
      // Helmet sets various headers
      expect(res.headers['x-content-type-options']).to.equal('nosniff');
    });
  });
});
