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
const { createTestApp, createMockTracker, MAX_JSONRPC_BATCH } = require('./support/test_app');

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

function registerBatchCapTests() {
  describe('JSON-RPC batch cap', function () {
    it('rejects a batch larger than MAX_JSONRPC_BATCH with -32600', async function () {
      const batch = Array.from({ length: MAX_JSONRPC_BATCH + 1 },
        (_, i) => ({ jsonrpc: '2.0', method: 'ping', id: i }));
      const res = await supertest(app).post('/').send(batch).expect(400);
      expect(res.body.error.code).to.equal(-32600);
      expect(res.body.error.message).to.match(/Batch too large/);
    });

    it('allows a batch at exactly MAX_JSONRPC_BATCH', async function () {
      const batch = Array.from({ length: MAX_JSONRPC_BATCH },
        (_, i) => ({ jsonrpc: '2.0', method: 'ping', id: i }));
      const res = await supertest(app).post('/').send(batch).expect(200);
      expect(res.body).to.be.an('array').with.length(MAX_JSONRPC_BATCH);
    });
  });
}

describe('API', function () {
  registerApiHooks();
  registerBatchCapTests();
});

