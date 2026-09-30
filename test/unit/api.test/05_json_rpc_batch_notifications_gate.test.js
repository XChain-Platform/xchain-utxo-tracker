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

// The JSON-RPC router never awaits a batch entry that has no id (a
// notification), so its promise can settle while that entry's read still runs.
// These tests pin that the concurrency slot stays held until every dispatched
// method has settled, notifications included, with nothing changed on the wire.

const { expect } = require('chai');
const sinon = require('sinon');
const supertest = require('supertest');
const { createTestApp, createMockTracker } = require('./support/test_app');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function gateInFlight(app) {
  // Read the body whatever the status: /status can answer 503 on a mock tracker.
  const res = await supertest(app).get('/status');
  return res.body.request_gate.in_flight;
}

// Wait until the gate has drained, so a released slot is not read as still held.
async function waitForInFlight(app, expected) {
  const deadline = Date.now() + 2000;
  let seen;
  while (Date.now() < deadline) {
    seen = await gateInFlight(app);
    if (seen === expected) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`request_gate.in_flight stayed at ${seen}, expected ${expected}`);
}

let app;
let parked;
let entered;

function registerHooks() {
  beforeEach(function () {
    parked = deferred();
    entered = 0;
    app = createTestApp(createMockTracker(sinon), '', {
      UTXO_TRACKER_MAX_CONCURRENT_REQUESTS: 1,
      jsonRpcMethods: {
        async slow_scan() {
          entered++;
          return parked.promise;
        }
      }
    });
  });

  afterEach(function () {
    // Always settle the parked read: the unit suite runs with no timeout.
    parked.resolve('done');
    sinon.restore();
  });
}

async function notificationOnlyBatchHoldsSlot() {
  const notification = [{ jsonrpc: '2.0', method: 'slow_scan' }];

  const first = await supertest(app).post('/').send(notification).expect(200);
  expect(first.body).to.deep.equal([]);
  expect(entered).to.equal(1);
  expect(await gateInFlight(app)).to.equal(1);

  // The cap of 1 is still spent on the running read, so the next batch is shed.
  const second = await supertest(app).post('/').send(notification).expect(429);
  expect(second.body.code).to.equal('SERVER_BUSY');
  expect(entered).to.equal(1);

  parked.resolve('done');
  await waitForInFlight(app, 0);
  await supertest(app).post('/').send([{ jsonrpc: '2.0', method: 'ping', id: 7 }]).expect(200);
}

async function mixedBatchHoldsSlot() {
  const batch = [
    { jsonrpc: '2.0', method: 'ping', id: 1 },
    { jsonrpc: '2.0', method: 'slow_scan' }
  ];

  const res = await supertest(app).post('/').send(batch).expect(200);
  expect(res.body).to.deep.equal([{ jsonrpc: '2.0', result: { status: 'success' }, id: 1 }]);
  expect(await gateInFlight(app)).to.equal(1);

  parked.resolve('done');
  await waitForInFlight(app, 0);
}

async function failingNotificationReleasesSlot() {
  const res = await supertest(app).post('/').send([{ jsonrpc: '2.0', method: 'slow_scan' }]).expect(200);
  expect(res.body).to.deep.equal([]);
  expect(await gateInFlight(app)).to.equal(1);

  parked.reject(new Error('scan failed'));
  await waitForInFlight(app, 0);
}

describe('API: JSON-RPC batch notifications hold their gate slot', function () {
  registerHooks();
  it('keeps the slot for a notification-only batch until its read settles', notificationOnlyBatchHoldsSlot);
  it('answers only the id-carrying entries of a mixed batch and holds the slot for the rest', mixedBatchHoldsSlot);
  it('releases the slot once a failing notification settles', failingNotificationReleasesSlot);
});
