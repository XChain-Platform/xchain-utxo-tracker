'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const helmet = require('helmet');
const supertest = require('supertest');

// We can't import api.js directly (it calls startApi and hits real env vars).
// Instead, we construct the Express app with mocked tracker.
function createTestApp(mockTracker) {
  const app = express();
  app.use(helmet());
  app.use(bodyParser.json());
  app.use(cors());

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
      res.json(balance);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/info/:address', async (req, res) => {
    try {
      const info = await getInfo(req.params.address);
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
      if (pattern.length < 32) {
        return { error: 'pattern is too short' };
      }
      const results = await mockTracker.db.getValuesFromKeyPattern(pattern);
      return { result: results };
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
      expect(res.body).to.deep.equal(info);
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
    function rpcRequest(method, params = {}) {
      return supertest(app)
        .post('/')
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
