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
const sinon = require('sinon');
const {
  SATOSHI, TEST_KEYS,
  makeOutput, makeSpendInput, makeTx, makeCoinbaseTx,
  makeBlock, buildCoinbaseChain,
  stubBlockchain, addBlockToState, addMempoolTx,
  sleep, waitForHeight, waitForSynced,
  createE2ETracker, patchLevelUpStoreInMemory,
  createApiApp
} = require('./helpers');

describe('E2E: API Correctness', function () {
  let tracker;
  let restoreLevelUp;
  let app;
  let request;

  beforeEach(function () {
    restoreLevelUp = patchLevelUpStoreInMemory();
    tracker = createE2ETracker();
  });

  afterEach(async function () {
    sinon.restore();
    await tracker.stopParsing();
    restoreLevelUp();
  });

  // Seed 3 blocks and start the API
  async function seedAndStart() {
    const cb0 = makeCoinbaseTx(0, 10 * SATOSHI);
    const cb1 = makeCoinbaseTx(0, 20 * SATOSHI);
    const cb2 = makeCoinbaseTx(0, 30 * SATOSHI);
    const block0 = makeBlock(0, '0'.repeat(64), [cb0]);
    const block1 = makeBlock(1, block0.hash, [cb1]);
    const block2 = makeBlock(2, block1.hash, [cb2]);

    const state = stubBlockchain(tracker, [block0, block1, block2]);
    tracker.start();
    await waitForSynced(tracker);

    const apiSetup = createApiApp(tracker);
    app = apiSetup.app;
    request = apiSetup.request;

    return { state, blocks: [block0, block1, block2], coinbases: [cb0, cb1, cb2] };
  }

  // ─── E2E-F1: REST Endpoint Parity ──────────────────────────────────────

  describe('F1: REST endpoint parity', function () {
    it('all REST endpoints return consistent data', async function () {
      await seedAndStart();

      const utxosRes = await request.get('/utxos/' + TEST_KEYS[0].address).expect(200);
      const balanceRes = await request.get('/balance/' + TEST_KEYS[0].address).expect(200);
      const infoRes = await request.get('/info/' + TEST_KEYS[0].address).expect(200);
      const firstSeenRes = await request.get('/firstseen/' + TEST_KEYS[0].address).expect(200);

      // Consistency checks
      const utxos = utxosRes.body;
      const balance = balanceRes.body;
      const info = infoRes.body;

      expect(utxos).to.be.an('array').with.length(3);

      // Balance = sum of UTXO amounts
      const utxoSum = utxos.reduce((sum, u) => sum + u.amount, 0);
      expect(balance).to.equal(utxoSum);
      expect(balance).to.equal(60); // 10 + 20 + 30

      // Info confirmed = balance
      expect(parseFloat(info.balances.confirmed)).to.equal(balance);
      expect(info.utxos.confirmed).to.equal(utxos.length);

      // Address info
      expect(info.address).to.equal(TEST_KEYS[0].address);
      expect(info.type).to.equal('p2pkh');

      // First-seen height <= all UTXO heights
      const firstSeen = firstSeenRes.body;
      expect(firstSeen).to.deep.equal({ height: 0 });
      for (const u of utxos) {
        expect(u.height).to.be.at.least(firstSeen.height);
      }
    });
  });

  // ─── E2E-F2: JSON-RPC Method Parity ───────────────────────────────────

  describe('F2: JSON-RPC method parity', function () {
    function rpcCall(method, params = {}) {
      return request.post('/')
        .send({ jsonrpc: '2.0', method, params, id: 1 })
        .expect(200);
    }

    it('JSON-RPC methods return identical data to REST endpoints', async function () {
      await seedAndStart();
      const addr = TEST_KEYS[0].address;

      // REST calls
      const restUtxos = await request.get('/utxos/' + addr).expect(200);
      const restBalance = await request.get('/balance/' + addr).expect(200);
      const restInfo = await request.get('/info/' + addr).expect(200);
      const restFirstSeen = await request.get('/firstseen/' + addr).expect(200);

      // JSON-RPC calls
      const rpcUtxos = await rpcCall('get_utxos', { address: addr });
      const rpcBalance = await rpcCall('get_balance', { address: addr });
      const rpcInfo = await rpcCall('get_info', { address: addr });
      const rpcFirstSeen = await rpcCall('get_first_seen', { address: addr });

      // Compare
      expect(rpcUtxos.body.result.utxos).to.deep.equal(restUtxos.body);
      expect(rpcBalance.body.result.balance).to.equal(restBalance.body);
      expect(rpcInfo.body.result.balances).to.deep.equal(restInfo.body.balances);
      expect(rpcFirstSeen.body.result.height).to.equal(restFirstSeen.body.height);
    });

    it('ping returns success', async function () {
      await seedAndStart();
      const res = await rpcCall('ping');
      expect(res.body.result.status).to.equal('success');
    });
  });

  // ─── E2E-F3: get_input_from_key_pattern ────────────────────────────────

  describe('F3: get_input_from_key_pattern', function () {
    it('returns matching entries for a valid pattern', async function () {
      const { coinbases } = await seedAndStart();

      // Use the first 16 hex chars of a known txid as pattern (must be >= 32 chars)
      // Build a pattern from the H prefix key: 0x48 + txHash8 (16 chars) = need more
      // Actually the pattern needs to be >= 32 hex chars (16 bytes)
      // Let's use the scriptHash of addr 0 which is 64 hex chars
      const pattern = TEST_KEYS[0].scriptHash;

      const res = await request.post('/')
        .send({
          jsonrpc: '2.0',
          method: 'get_input_from_key_pattern',
          params: { pattern },
          id: 1
        })
        .expect(200);

      // Should find entries keyed by scriptHash (O prefix keys contain scriptPubKey)
      expect(res.body.result).to.not.be.null;
      // The pattern matches any key starting with those bytes
      expect(res.body.result.result).to.be.an('array');
    });
  });

  // ─── E2E-F4: Invalid Address Handling ──────────────────────────────────

  describe('F4: invalid address handling', function () {
    it('returns error for malformed addresses', async function () {
      await seedAndStart();

      // These should return 500 or empty results, not crash
      const res = await request.get('/info/invalidaddress123');
      expect(res.status).to.equal(500);

      const res2 = await request.get('/utxos/notanaddress');
      expect(res2.status).to.equal(500);

      const res3 = await request.get('/balance/xyz');
      expect(res3.status).to.equal(500);
    });
  });

  // ─── E2E-F5: Concurrent Queries During Indexing ────────────────────────

  describe('F5: concurrent queries during indexing', function () {
    it('handles simultaneous API requests without errors', async function () {
      // Start with 3 blocks, then add 10 more while querying
      const blocks = buildCoinbaseChain(3, 0, 0, 10 * SATOSHI);
      const state = stubBlockchain(tracker, blocks);

      tracker.start();
      await waitForSynced(tracker);

      const apiSetup = createApiApp(tracker);
      app = apiSetup.app;
      request = apiSetup.request;

      // Add 10 more blocks
      for (let i = 3; i < 13; i++) {
        const prevHash = state.blocks[state.blocks.length - 1].hash;
        const newBlock = makeBlock(i, prevHash, [makeCoinbaseTx(0, 10 * SATOSHI)]);
        addBlockToState(state, newBlock);
      }

      // Fire concurrent queries while tracker is indexing
      const queryPromises = [];
      for (let i = 0; i < 10; i++) {
        queryPromises.push(
          request.get('/info/' + TEST_KEYS[0].address).then(res => {
            expect(res.status).to.equal(200);
            expect(res.body.balances).to.have.property('confirmed');
            return parseFloat(res.body.balances.confirmed);
          })
        );
      }

      const balances = await Promise.all(queryPromises);

      // All queries should succeed (no 500s)
      for (const b of balances) {
        expect(b).to.be.a('number');
        expect(b).to.be.at.least(30); // At least the initial 3 blocks
      }

      // Wait for indexing to finish
      await waitForHeight(tracker, 12);

      // Final balance should be 130 BTC (13 blocks * 10 BTC each)
      const finalRes = await request.get('/info/' + TEST_KEYS[0].address).expect(200);
      expect(finalRes.body.balances.confirmed).to.equal('130.00000000');
    });
  });

  // ─── E2E-F6: API Reflects Mempool State ────────────────────────────────

  describe('F6: API reflects mempool state', function () {
    it('shows pending balances through the API after mempool update', async function () {
      const { state, coinbases } = await seedAndStart();

      // Add mempool tx
      const mempoolTx = makeTx({
        ins: [makeSpendInput(coinbases[0]._txid, 0)],
        outs: [makeOutput(1, 8 * SATOSHI)]
      });
      addMempoolTx(state, mempoolTx);
      await tracker.updateMempool();

      // Query via REST
      const infoRes = await request.get('/info/' + TEST_KEYS[1].address).expect(200);
      expect(infoRes.body.balances.pending).to.equal('8.00000000');
      expect(infoRes.body.balances.confirmed).to.equal('0.00000000');

      // Query via JSON-RPC
      const rpcRes = await request.post('/')
        .send({ jsonrpc: '2.0', method: 'get_info', params: { address: TEST_KEYS[1].address }, id: 1 })
        .expect(200);
      expect(rpcRes.body.result.balances.pending).to.equal('8.00000000');
    });
  });

  // ─── E2E-F7: Non-Existent Address Through All Endpoints ───────────────

  describe('F7: non-existent address through all endpoints', function () {
    it('returns empty/zero state consistently', async function () {
      await seedAndStart();
      const emptyAddr = TEST_KEYS[7].address;

      const utxosRes = await request.get('/utxos/' + emptyAddr).expect(200);
      expect(utxosRes.body).to.be.an('array').with.length(0);

      const balanceRes = await request.get('/balance/' + emptyAddr).expect(200);
      expect(balanceRes.body).to.equal(0);

      const infoRes = await request.get('/info/' + emptyAddr).expect(200);
      expect(infoRes.body.balances.confirmed).to.equal('0.00000000');
      expect(infoRes.body.balances.pending).to.equal('0.00000000');
      expect(infoRes.body.utxos.confirmed).to.equal(0);

      const rpcRes = await request.post('/')
        .send({ jsonrpc: '2.0', method: 'get_utxos', params: { address: emptyAddr }, id: 1 })
        .expect(200);
      expect(rpcRes.body.result.utxos).to.be.an('array').with.length(0);
    });
  });
});
