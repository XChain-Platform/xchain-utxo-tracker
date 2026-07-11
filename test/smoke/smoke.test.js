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
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const helmet = require('helmet');
const supertest = require('supertest');
const jsonRouter = require('express-json-rpc-router');

const {
  TEST_KEYS,
  SATOSHI,
  makeCoinbaseTx,
  makeTx,
  makeSpendInput,
  makeOutput,
  makeBlock,
  processAndCommit,
  createTestTracker,
  closeTracker
} = require('../integration/helpers');

describe('UTXO Tracker Smoke Tests', function () {
  let tracker;

  before(async function () {
    tracker = await createTestTracker();
  });

  after(async function () {
    await closeTracker(tracker);
  });

  // ── ST-01: Service Initialization ──────────────────────────────────────────

  it('ST-01: initializes tracker and databases without error', function () {
    expect(tracker).to.not.be.null;
    expect(tracker.db).to.not.be.null;
    expect(tracker.db.db).to.not.be.null;
    expect(tracker.mempoolDb).to.not.be.null;
    expect(tracker.mempoolDb.db).to.not.be.null;
  });

  // ── ST-02: LevelDB Read/Write Round-Trip ───────────────────────────────────

  it('ST-02: reads back block height and hash after writing', async function () {
    const db = tracker.db;

    await db.beginTransaction();
    await db.setLastBlockHeight(42);
    await db.setLastBlockHash('aa'.repeat(32));
    await db.endTransaction();

    const height = await db.getLastBlockHeight();
    const hash = await db.getLastBlockHash();

    expect(height).to.equal(42);
    expect(hash).to.equal('aa'.repeat(32));

    // Reset for subsequent tests
    await db.beginTransaction();
    await db.setLastBlockHeight(-1);
    await db.setLastBlockHash('');
    await db.endTransaction();
  });

  // ── ST-03: Single Block Indexing (Coinbase Only) ───────────────────────────

  describe('after indexing one coinbase block', function () {
    const genesisHash = '00'.repeat(32);
    let block0;

    before(async function () {
      const coinbaseTx = makeCoinbaseTx(0, 50 * SATOSHI);
      block0 = makeBlock(0, genesisHash, [coinbaseTx]);
      await processAndCommit(tracker, block0);
    });

    it('ST-03: stores the block and output correctly', async function () {
      const height = await tracker.db.getLastBlockHeight();
      expect(height).to.equal(0);

      const outputs = await tracker.db.getOutputsScriptPubKey(TEST_KEYS[0].scriptHash);
      expect(outputs).to.be.an('array').with.lengthOf(1);
      expect(outputs[0].value).to.equal('5000000000');
      expect(outputs[0].vout).to.equal(0);
    });

    // ── ST-04: UTXO Query by Address ─────────────────────────────────────────

    it('ST-04: returns UTXOs when queried by address', async function () {
      const utxos = await tracker.getUtxosAddress(TEST_KEYS[0].address);

      expect(utxos).to.be.an('array').with.lengthOf(1);
      expect(utxos[0].vout).to.equal(0);
      expect(utxos[0].value).to.equal('5000000000');
      // amount is a BigInt-formatted decimal string (cc7576d): float math is
      // unsafe above ~90M coins, so the API returns '50.00000000', not 50.
      expect(utxos[0].amount).to.equal('50.00000000');
      expect(utxos[0].scriptPubKey).to.be.a('string').that.is.not.empty;
    });

    // ── ST-05: Balance Query by Address ──────────────────────────────────────

    it('ST-05: returns correct balance info for a funded address', async function () {
      const info = await tracker.getBalanceInfo(TEST_KEYS[0].address);

      expect(info.address).to.equal(TEST_KEYS[0].address);
      expect(info.type).to.equal('p2pkh');
      expect(info.balances.confirmed).to.equal('50.00000000');
      expect(info.balances.pending).to.equal('0.00000000');
      expect(info.utxos.confirmed).to.equal(1);
      expect(info.utxos.pending).to.equal(0);
    });

    // ── ST-06: Spending a UTXO ───────────────────────────────────────────────

    it('ST-06: removes spent output and creates new output after a spend', async function () {
      // Get the txid of the coinbase output to spend
      const utxosBefore = await tracker.getUtxosAddress(TEST_KEYS[0].address);
      const prevTxId = utxosBefore[0].txid;

      // Build a transaction spending address[0] -> address[1]
      const spendTx = makeTx({
        ins: [makeSpendInput(prevTxId, 0)],
        outs: [makeOutput(1, 49 * SATOSHI)]
      });

      const block1 = makeBlock(1, block0.hash, [makeCoinbaseTx(2), spendTx]);
      await processAndCommit(tracker, block1);

      // Address 0 should now have zero UTXOs (REMOVE_SPENT=true deletes spent outputs)
      const utxosAddr0 = await tracker.getUtxosAddress(TEST_KEYS[0].address);
      expect(utxosAddr0).to.be.an('array').with.lengthOf(0);

      // Address 1 should have the new output
      const utxosAddr1 = await tracker.getUtxosAddress(TEST_KEYS[1].address);
      expect(utxosAddr1).to.be.an('array').with.lengthOf(1);
      expect(utxosAddr1[0].value).to.equal((49 * SATOSHI).toString());
    });

    // ── ST-09: Empty Address Query ───────────────────────────────────────────

    it('ST-09: returns empty array for an address with no UTXOs', async function () {
      const utxos = await tracker.getUtxosAddress(TEST_KEYS[9].address);
      expect(utxos).to.be.an('array').with.lengthOf(0);
    });
  });

  // ── ST-07 & ST-08: Express API Health Check ────────────────────────────────

  describe('Express API layer', function () {
    let app;

    before(async function () {
      // Build a minimal Express app wired to the real tracker (already has indexed data)
      app = express();
      app.use(helmet());
      app.use(bodyParser.json());
      app.use(cors());

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
          const utxos = await tracker.getUtxosAddress(req.params.address);
          let balance = 0;
          for (const u of utxos) balance += u.amount;
          res.json(balance);
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

      const jsonRpcController = {
        async ping() { return { status: 'success' }; },
        async get_utxos({ address }) {
          const utxos = await tracker.getUtxosAddress(address);
          return { utxos };
        },
        async get_balance({ address }) {
          const utxos = await tracker.getUtxosAddress(address);
          let balance = 0;
          for (const u of utxos) balance += u.amount;
          return { balance };
        },
        async get_info({ address }) {
          return await tracker.getBalanceInfo(address);
        }
      };

      app.use(jsonRouter({ methods: jsonRpcController }));
    });

    it('ST-07: JSON-RPC ping returns success', async function () {
      const res = await supertest(app)
        .post('/')
        .send({ jsonrpc: '2.0', method: 'ping', id: 1 })
        .expect(200);

      expect(res.body.result).to.deep.include({ status: 'success' });
    });

    it('ST-08: GET /utxos/:address returns a JSON array', async function () {
      const res = await supertest(app)
        .get('/utxos/' + TEST_KEYS[1].address)
        .expect(200);

      expect(res.body).to.be.an('array');
      expect(res.body.length).to.be.greaterThan(0);
    });
  });
});
