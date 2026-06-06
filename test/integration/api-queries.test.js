'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const { expect } = require('chai');
const express = require('express');
const bodyParser = require('body-parser');
const supertest = require('supertest');
const jsonRouter = require('express-json-rpc-router');
const {
  SATOSHI, TEST_KEYS,
  makeOutput, makeSpendInput, makeTx, makeCoinbaseTx,
  makeBlock, processAndCommit, processBlocksAndCommit,
  createTestTracker, closeTracker
} = require('./helpers');

describe('Integration: API Queries', function () {
  let tracker;
  let app;
  let request;

  beforeEach(async function () {
    tracker = await createTestTracker();
    tracker.blockchainInfoLastBlock = 100;

    // Build a minimal Express app wired to the real tracker
    app = express();
    app.use(bodyParser.json());

    app.get('/utxos/:address', async (req, res) => {
      const utxos = await tracker.getUtxosAddress(req.params.address);
      res.json(utxos);
    });

    app.get('/balance/:address', async (req, res) => {
      const utxos = await tracker.getUtxosAddress(req.params.address);
      let balance = 0;
      for (const u of utxos) { balance += u.amount; }
      res.json(balance);
    });

    app.get('/firstseen/:address', async (req, res) => {
      const firstSeen = await tracker.getFirstSeen(req.params.address);
      res.json(firstSeen);
    });

    app.get('/info/:address', async (req, res) => {
      const info = await tracker.getBalanceInfo(req.params.address);
      res.json(info);
    });

    const jsonRpcController = {
      async ping() { return { status: 'success' }; },
      async get_utxos({ address }) {
        return { utxos: await tracker.getUtxosAddress(address) };
      },
      async get_balance({ address }) {
        const utxos = await tracker.getUtxosAddress(address);
        let balance = 0;
        for (const u of utxos) { balance += u.amount; }
        return { balance };
      },
      async get_first_seen({ address }) {
        return await tracker.getFirstSeen(address);
      },
      async get_info({ address }) {
        return await tracker.getBalanceInfo(address);
      }
    };

    app.use(jsonRouter({ methods: jsonRpcController }));
    request = supertest(app);
  });

  afterEach(async function () {
    await closeTracker(tracker);
  });

  // Seed some data: 3 blocks, addr0 gets coinbase each time
  async function seedData() {
    const block0 = makeBlock(0, '0'.repeat(64), [makeCoinbaseTx(0, 10 * SATOSHI)]);
    const block1 = makeBlock(1, block0.hash, [makeCoinbaseTx(0, 20 * SATOSHI)]);
    const block2 = makeBlock(2, block1.hash, [makeCoinbaseTx(0, 30 * SATOSHI)]);
    await processBlocksAndCommit(tracker, [block0, block1, block2]);
  }

  // ─── Scenario 5.1: REST Endpoints ─────────────────────────────────────

  describe('REST endpoints', function () {
    it('GET /utxos/:address returns correct UTXO list', async function () {
      await seedData();
      const res = await request.get('/utxos/' + TEST_KEYS[0].address).expect(200);
      expect(res.body).to.be.an('array').with.length(3);
      const amounts = res.body.map(u => u.amount).sort((a, b) => a - b);
      expect(amounts).to.deep.equal([10, 20, 30]);
    });

    it('GET /balance/:address returns total balance', async function () {
      await seedData();
      const res = await request.get('/balance/' + TEST_KEYS[0].address).expect(200);
      expect(res.body).to.equal(60); // 10+20+30
    });

    it('GET /firstseen/:address returns first-seen height', async function () {
      await seedData();
      const res = await request.get('/firstseen/' + TEST_KEYS[0].address).expect(200);
      expect(res.body).to.deep.equal({ height: 0 });
    });

    it('GET /info/:address returns full balance info', async function () {
      await seedData();
      const res = await request.get('/info/' + TEST_KEYS[0].address).expect(200);
      expect(res.body.balances.confirmed).to.equal('60.00000000');
      expect(res.body.utxos.confirmed).to.equal(3);
      expect(res.body.address).to.equal(TEST_KEYS[0].address);
      expect(res.body.type).to.equal('p2pkh');
    });
  });

  // ─── Scenario 5.2: JSON-RPC Methods ───────────────────────────────────

  describe('JSON-RPC methods', function () {
    function rpcCall(method, params = {}) {
      return request.post('/')
        .send({ jsonrpc: '2.0', method, params, id: 1 })
        .expect(200);
    }

    it('ping returns success', async function () {
      const res = await rpcCall('ping');
      expect(res.body.result.status).to.equal('success');
    });

    it('get_utxos returns correct UTXOs', async function () {
      await seedData();
      const res = await rpcCall('get_utxos', { address: TEST_KEYS[0].address });
      expect(res.body.result.utxos).to.be.an('array').with.length(3);
    });

    it('get_balance returns correct balance', async function () {
      await seedData();
      const res = await rpcCall('get_balance', { address: TEST_KEYS[0].address });
      expect(res.body.result.balance).to.equal(60);
    });

    it('get_first_seen returns height', async function () {
      await seedData();
      const res = await rpcCall('get_first_seen', { address: TEST_KEYS[0].address });
      expect(res.body.result).to.deep.equal({ height: 0 });
    });

    it('get_info returns full balance info', async function () {
      await seedData();
      const res = await rpcCall('get_info', { address: TEST_KEYS[0].address });
      expect(res.body.result.balances.confirmed).to.equal('60.00000000');
    });
  });

  // ─── Scenario 5.3: Non-Existent Address ───────────────────────────────

  describe('non-existent address queries', function () {
    it('REST /utxos returns empty array', async function () {
      await seedData();
      const res = await request.get('/utxos/' + TEST_KEYS[5].address).expect(200);
      expect(res.body).to.be.an('array').with.length(0);
    });

    it('REST /balance returns 0', async function () {
      await seedData();
      const res = await request.get('/balance/' + TEST_KEYS[5].address).expect(200);
      expect(res.body).to.equal(0);
    });

    it('REST /info returns zero balances', async function () {
      await seedData();
      const res = await request.get('/info/' + TEST_KEYS[5].address).expect(200);
      expect(res.body.balances.confirmed).to.equal('0.00000000');
      expect(res.body.balances.pending).to.equal('0.00000000');
      expect(res.body.utxos.confirmed).to.equal(0);
    });

    it('JSON-RPC get_utxos returns empty', async function () {
      await seedData();
      const res = await request.post('/')
        .send({ jsonrpc: '2.0', method: 'get_utxos', params: { address: TEST_KEYS[5].address }, id: 1 })
        .expect(200);
      expect(res.body.result.utxos).to.be.an('array').with.length(0);
    });
  });

  // ─── Scenario 5.4: API reflects state changes ────────────────────────

  describe('API reflects state changes', function () {
    it('balance updates after processing new blocks', async function () {
      await seedData();

      const res1 = await request.get('/balance/' + TEST_KEYS[0].address).expect(200);
      expect(res1.body).to.equal(60);

      // Process one more block
      const lastHash = (await tracker.db.getLastBlockHash());
      const block3 = makeBlock(3, lastHash, [makeCoinbaseTx(0, 40 * SATOSHI)]);
      await processAndCommit(tracker, block3);

      const res2 = await request.get('/balance/' + TEST_KEYS[0].address).expect(200);
      expect(res2.body).to.equal(100); // 60 + 40
    });
  });
});
