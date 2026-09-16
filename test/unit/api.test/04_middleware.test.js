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
const { createTestApp, createMockTracker } = require('./support/test_app');

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

function registerMiddlewareTests() {
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
}

describe('API', function () {
  registerApiHooks();
  registerMiddlewareTests();
});
