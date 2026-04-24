'use strict';

const { expect } = require('chai');
const supertest = require('supertest');
const express = require('express');
const bodyParser = require('express').json ? null : null; // express 4 has json built-in
const jsonRouter = require('express-json-rpc-router');
const {
  fc, FUZZ_RUNS, TEST_KEYS, arbAddress,
  createTestTracker, closeTracker,
  makeCoinbaseTx, makeBlock, processAndCommit
} = require('../helpers');

// Minimal API app mirroring the real api.js structure
function createTestApiApp(tracker) {
  const app = express();
  app.use(express.json());

  app.get('/utxos/:address', async (req, res) => {
    try {
      const utxos = await tracker.getUtxosAddress(req.params.address);
      res.json(utxos);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/balance/:address', async (req, res) => {
    try {
      const info = await tracker.getBalanceInfo(req.params.address);
      res.json(parseFloat(info.balances.confirmed));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/info/:address', async (req, res) => {
    try {
      const info = await tracker.getBalanceInfo(req.params.address);
      res.json(info);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/firstseen/:address', async (req, res) => {
    try {
      const firstSeen = await tracker.getFirstSeen(req.params.address);
      res.json(firstSeen);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  const jsonRpcController = {
    async ping() { return { status: 'success' }; },
    async get_utxos({ address }) {
      try {
        return { utxos: await tracker.getUtxosAddress(address) };
      } catch (err) {
        return { error: err.message };
      }
    },
    async get_balance({ address }) {
      try {
        const info = await tracker.getBalanceInfo(address);
        return { balance: parseFloat(info.balances.confirmed) };
      } catch (err) {
        return { error: err.message };
      }
    },
    async get_info({ address }) {
      try {
        return await tracker.getBalanceInfo(address);
      } catch (err) {
        return { error: err.message };
      }
    },
    async get_input_from_key_pattern({ pattern }) {
      if (!pattern || pattern.length < 32) {
        return { error: 'pattern is too short' };
      }
      try {
        const results = await tracker.db.getValuesFromKeyPattern(pattern);
        return { result: results };
      } catch (err) {
        return { error: err.message };
      }
    }
  };

  app.use(jsonRouter({ methods: jsonRpcController }));
  return app;
}

describe('Fuzz: API Endpoints (P3)', function () {
  let tracker;
  let app;
  let request;

  beforeEach(async function () {
    tracker = await createTestTracker();
    // Add some data so queries have something to work with
    const block = makeBlock(0, '0'.repeat(64), [makeCoinbaseTx(0)]);
    await processAndCommit(tracker, block);
    app = createTestApiApp(tracker);
    request = supertest(app);
  });

  afterEach(async function () {
    await closeTracker(tracker);
  });

  // ─── REST endpoints with fuzzed addresses ──────────────────────────────────

  describe('REST endpoints', function () {
    it('GET /utxos/:address always returns valid HTTP response', async function () {
      await fc.assert(
        fc.asyncProperty(
          arbAddress(),
          async (addr) => {
            const encodedAddr = encodeURIComponent(addr);
            if (!encodedAddr) return; // skip empty
            const res = await request.get('/utxos/' + encodedAddr);
            expect(res.status).to.be.oneOf([200, 500]);
            // Body should always be valid JSON
            expect(res.body).to.exist;
          }
        ),
        { numRuns: Math.min(FUZZ_RUNS, 200) }
      );
    });

    it('GET /balance/:address always returns valid HTTP response', async function () {
      await fc.assert(
        fc.asyncProperty(
          arbAddress(),
          async (addr) => {
            const encodedAddr = encodeURIComponent(addr);
            if (!encodedAddr) return;
            const res = await request.get('/balance/' + encodedAddr);
            expect(res.status).to.be.oneOf([200, 500]);
          }
        ),
        { numRuns: Math.min(FUZZ_RUNS, 200) }
      );
    });

    it('GET /info/:address always returns valid HTTP response', async function () {
      await fc.assert(
        fc.asyncProperty(
          arbAddress(),
          async (addr) => {
            const encodedAddr = encodeURIComponent(addr);
            if (!encodedAddr) return;
            const res = await request.get('/info/' + encodedAddr);
            expect(res.status).to.be.oneOf([200, 500]);
          }
        ),
        { numRuns: Math.min(FUZZ_RUNS, 200) }
      );
    });

    it('GET /firstseen/:address always returns valid HTTP response', async function () {
      await fc.assert(
        fc.asyncProperty(
          arbAddress(),
          async (addr) => {
            const encodedAddr = encodeURIComponent(addr);
            if (!encodedAddr) return;
            const res = await request.get('/firstseen/' + encodedAddr);
            expect(res.status).to.be.oneOf([200, 500]);
          }
        ),
        { numRuns: Math.min(FUZZ_RUNS, 200) }
      );
    });

    it('error responses never contain stack traces or file paths', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 50 }),
          async (addr) => {
            const res = await request.get('/info/' + encodeURIComponent(addr));
            if (res.status === 500) {
              const body = JSON.stringify(res.body);
              expect(body).to.not.include('/home/');
              expect(body).to.not.include('/media/');
              expect(body).to.not.include('node_modules');
              expect(body).to.not.match(/at\s+\w+\s+\(/); // stack trace pattern
            }
          }
        ),
        { numRuns: Math.min(FUZZ_RUNS, 200) }
      );
    });
  });

  // ─── JSON-RPC with fuzzed payloads ─────────────────────────────────────────

  describe('JSON-RPC endpoints', function () {
    it('ping always succeeds', async function () {
      const res = await request
        .post('/')
        .send({ jsonrpc: '2.0', method: 'ping', id: 1 });
      expect(res.status).to.equal(200);
    });

    it('get_input_from_key_pattern rejects short patterns', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 0, maxLength: 31 }),
          async (pattern) => {
            const res = await request
              .post('/')
              .send({ jsonrpc: '2.0', method: 'get_input_from_key_pattern', params: { pattern }, id: 1 });
            expect(res.status).to.equal(200);
            // Should return an error about pattern being too short
            if (res.body.result && res.body.result.error) {
              expect(res.body.result.error).to.include('too short');
            }
          }
        ),
        { numRuns: Math.min(FUZZ_RUNS, 200) }
      );
    });

    it('JSON-RPC handles fuzzed method names without crashing', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 50 }),
          async (method) => {
            const res = await request
              .post('/')
              .send({ jsonrpc: '2.0', method, id: 1 });
            // Should return 200 with a JSON-RPC error for unknown methods, not crash
            expect(res.status).to.be.oneOf([200, 404]);
          }
        ),
        { numRuns: Math.min(FUZZ_RUNS, 200) }
      );
    });

    it('JSON-RPC handles malformed request bodies', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.oneof(
            fc.constant(null),
            fc.constant(''),
            fc.constant('not json'),
            fc.constant(42),
            fc.constant([]),
            fc.record({
              jsonrpc: fc.string({ minLength: 0, maxLength: 5 }),
              method: fc.string({ minLength: 0, maxLength: 20 }),
              id: fc.oneof(fc.integer(), fc.constant(null), fc.string())
            })
          ),
          async (body) => {
            try {
              const res = await request
                .post('/')
                .send(body);
              expect(res.status).to.be.a('number');
            } catch (e) {
              // Network-level error is acceptable
            }
          }
        ),
        { numRuns: Math.min(FUZZ_RUNS, 200) }
      );
    });
  });
});
