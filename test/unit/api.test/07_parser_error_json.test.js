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
const { getLogger } = require('../../../src/observability');

// Parser and param-decode failures must answer with bounded JSON, never the
// default HTML error page that carries a stack and filesystem paths.
describe('API parser and decode errors', function () {
  let app;

  beforeEach(function () {
    const mockTracker = createMockTracker(sinon);
    mockTracker.getUtxosAddress.resolves([]);
    app = createTestApp(mockTracker);
  });

  afterEach(function () {
    sinon.restore();
  });

  function expectBoundedJson(res, status) {
    expect(res.status).to.equal(status);
    expect(res.headers['content-type']).to.match(/application\/json/);
    expect(res.body).to.have.nested.property('error.code');
    expect(res.text).to.not.match(/node_modules|<html|<pre>|\bat .*\.js:\d+/i);
  }

  it('answers an unparsable JSON body with 400 JSON', async function () {
    const errSpy = sinon.spy(getLogger(), 'error');
    const res = await supertest(app).post('/')
      .set('content-type', 'application/json').send('{"jsonrpc":"2.0",');
    expectBoundedJson(res, 400);
    sinon.assert.notCalled(errSpy);
  });

  it('answers a body over 100 KB with 413 JSON', async function () {
    const errSpy = sinon.spy(getLogger(), 'error');
    const res = await supertest(app).post('/')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ jsonrpc: '2.0', method: 'x', params: ['a'.repeat(150 * 1024)] }));
    expectBoundedJson(res, 413);
    sinon.assert.notCalled(errSpy);
  });

  it('answers a bad percent-escape param with 400 JSON', async function () {
    const errSpy = sinon.spy(getLogger(), 'error');
    const res = await supertest(app).get('/utxos/%E0%A4%A');
    expectBoundedJson(res, 400);
    sinon.assert.notCalled(errSpy);
  });
});
