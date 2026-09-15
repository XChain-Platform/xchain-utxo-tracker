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

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const helmet = require('helmet');
const { timingSafeEqual } = require('crypto');
const XChainUtxoTracker = require('../../../../src/XChainUtxoTracker');

// Mirror of src/api.js keyEquals: length-guarded constant-time comparison.
function keyEquals(provided, expected) {
  const a = Buffer.from(String(provided == null ? '' : provided));
  const b = Buffer.from(String(expected == null ? '' : expected));
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// adminApiKey (optional) mirrors api.js's admin-method auth middleware so the
// batch-bypass regression can be exercised. ADMIN_METHODS is kept in sync with
// api.js's set of privileged JSON-RPC methods.
const ADMIN_METHODS = new Set([
  'getbootstrap', 'getbootstrapstatus',
  'restorebootstrap', 'getbootstraprestorestatus',
  'get_input_from_key_pattern'
]);

// Mirror of src/api.js MAX_JSONRPC_BATCH default.
const MAX_JSONRPC_BATCH = 20;

function createAdminGuard(adminApiKey) {
  return (req, res, next) => {
    const body = req.body;
    // Mirror of src/api.js: bound batch fan-out before the router's uncapped
    // Promise.all runs every entry.
    if (Array.isArray(body) && body.length > MAX_JSONRPC_BATCH) {
      return res.status(400).json({
        jsonrpc: '2.0', id: null,
        error: { code: -32600, message: 'Batch too large (max ' + MAX_JSONRPC_BATCH + ' requests per call)' }
      });
    }
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
  };
}

function createAddressAccessors(mockTracker) {
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
  // Mirror of src/api.js setFreshnessHeaders. The readiness verdict comes off the
  // REAL computeFreshness, which floors it on a negative lag; building it from the
  // raw isSynced() flag here would pin the contract production dropped.
  async function setFreshnessHeaders(res) {
    let committedHeight = -1;
    try { committedHeight = await mockTracker.db.getLastBlockHeight(); } catch (e) {}
    const rawTip = (typeof mockTracker.latestKnownChainTip === 'number') ? mockTracker.latestKnownChainTip : -1;
    const f = XChainUtxoTracker.computeFreshness(committedHeight, rawTip, mockTracker.isSynced(), {
      mempoolReconverged: mockTracker.isMempoolReconverged()
    });
    res.set('X-Tracker-Height', String(f.tracker_height));
    res.set('X-Node-Height', String(f.node_height));
    if (f.lag !== null) res.set('X-Sync-Lag', String(f.lag));
    res.set('X-Synced', String(f.synced));
    return f;
  }
  return { getUtxos, getFirstSeen, getBalance, getInfo, setFreshnessHeaders };
}

function registerAddressRoutes(app, access) {
  app.get('/utxos/:address', async (req, res) => {
    try {
      const utxos = await access.getUtxos(req.params.address);
      const freshness = await access.setFreshnessHeaders(res);
      res.set('X-Mempool-Ready', String(freshness.mempool_ready));
      res.json(utxos);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.get('/firstseen/:address', async (req, res) => {
    try {
      const result = await access.getFirstSeen(req.params.address);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.get('/balance/:address', async (req, res) => {
    try {
      const balance = await access.getBalance(req.params.address);
      const freshness = await access.setFreshnessHeaders(res);
      res.set('X-Mempool-Ready', String(freshness.mempool_ready));
      res.json(balance);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.get('/info/:address', async (req, res) => {
    try {
      const info = await access.getInfo(req.params.address);
      const freshness = await access.setFreshnessHeaders(res);
      res.set('X-Mempool-Ready', String(freshness.mempool_ready));
      if (info && typeof info === 'object') info.mempool_ready = freshness.mempool_ready;
      res.json(info);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

function createJsonRpcController(mockTracker, access) {
  return {
    async ping() {
      return { status: 'success' };
    },
    async get_utxos({ address }) {
      const utxos = await access.getUtxos(address);
      return { utxos };
    },
    async get_first_seen({ address }) {
      return await access.getFirstSeen(address);
    },
    async get_balance({ address }) {
      const balance = await access.getBalance(address);
      return { balance };
    },
    async get_info({ address }) {
      const info = await access.getInfo(address);
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
}

// We can't import api.js directly (it calls startApi and hits real env vars).
// Instead, we construct the Express app with mocked tracker.
function createTestApp(mockTracker, adminApiKey = '') {
  const app = express();
  app.use(helmet());
  app.use(bodyParser.json());
  app.use(cors());
  // Same guard as src/api.js: gate the whole request when ANY entry (single or
  // batch) names an admin method. Fails closed when no key is configured.
  app.use(createAdminGuard(adminApiKey));
  const access = createAddressAccessors(mockTracker);
  registerAddressRoutes(app, access);
  // JSON-RPC via POST
  const jsonRouter = require('express-json-rpc-router');
  app.use(jsonRouter({ methods: createJsonRpcController(mockTracker, access) }));
  return app;
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

module.exports = { createTestApp, createMockTracker, MAX_JSONRPC_BATCH };
