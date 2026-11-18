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

// A batch entry that is not a JSON object is a client fault. It is answered 400
// before the router runs: the router reads entry.id outside any try, so a null
// entry would reject the middleware (a 500 and an error-level stack) while the
// entry's own orphaned promise fires the process's unhandledRejection handler.

const { expect } = require('chai');
const sinon = require('sinon');
const supertest = require('supertest');
const { createTestApp, createMockTracker } = require('./support/test_app');

async function settleOrphans() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe('JSON-RPC batch entry shape', function () {
  let app;
  let mockTracker;
  let rejections;
  let onRejection;

  beforeEach(function () {
    mockTracker = createMockTracker(sinon);
    mockTracker.onAdminExecuted = sinon.stub();
    app = createTestApp(mockTracker, 'secret-key');
    rejections = [];
    onRejection = (reason) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    sinon.stub(console, 'error');
  });

  afterEach(function () {
    process.removeListener('unhandledRejection', onRejection);
    sinon.restore();
  });

  const bad = [
    ['a null entry', [null]],
    ['a null beside a valid request', [{ jsonrpc: '2.0', method: 'ping', id: 1 }, null]],
    ['a number', [1]],
    ['a string', ['ping']],
    ['a nested array', [[]]]
  ];

  for (const [label, batch] of bad) {
    it('answers 400 / -32600 for a batch holding ' + label + ', with no error log and no orphaned rejection', async function () {
      const res = await supertest(app).post('/').send(batch).expect(400);
      expect(res.body.error.code).to.equal(-32600);
      expect(res.body.error.message).to.match(/Invalid Request/);
      await settleOrphans();
      expect(rejections).to.deep.equal([]);
      expect(console.error.called).to.equal(false);
    });
  }

  it('never runs an admin method that rides in a batch with a null entry', async function () {
    await supertest(app)
      .post('/')
      .set('Authorization', 'Bearer secret-key')
      .send([{ jsonrpc: '2.0', method: 'getbootstrap', params: {}, id: 1 }, null])
      .expect(400);
    expect(mockTracker.onAdminExecuted.called).to.equal(false);
  });

  it('still answers a well-formed batch', async function () {
    const res = await supertest(app)
      .post('/')
      .send([{ jsonrpc: '2.0', method: 'ping', id: 1 }, { jsonrpc: '2.0', method: 'ping', id: 2 }])
      .expect(200);
    expect(res.body).to.have.length(2);
  });
});
