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

// Regression: a non-numeric get_utxos limit is a caller mistake answered with
// -32602 BAD_REQUEST, never silently coerced by Number() (true read as 1, [7] as 7).

const { expect } = require('chai');
const sinon = require('sinon');
const supertest = require('supertest');
const { createTestApp, createMockTracker } = require('../../unit/api.test/support/test_app');

function emptyPage() {
  const rows = [];
  Object.defineProperty(rows, 'committedHeight', { value: 7, enumerable: false });
  return rows;
}

async function rpc(app, limit) {
  return supertest(app).post('/')
    .send({ jsonrpc: '2.0', method: 'get_utxos', params: { address: 'addr1', limit }, id: 1 });
}

describe('Regression: get_utxos limit must be an integer, not a coerced value', function () {
  afterEach(function () { sinon.restore(); });

  const bad = [true, [7], {}, '1e1', '0x10', ' 5 ', 1.5];
  for (const limit of bad) {
    it('JSON-RPC limit ' + JSON.stringify(limit) + ' answers -32602 and reads nothing', async function () {
      const tracker = createMockTracker(sinon);
      tracker.getUtxosAddress.resolves(emptyPage());
      const res = await rpc(createTestApp(tracker), limit);
      expect(res.body.error, JSON.stringify(res.body)).to.be.an('object');
      expect(res.body.error.code).to.equal(-32602);
      expect(tracker.getUtxosAddress.called).to.equal(false);
    });
  }

  for (const limit of [5, '5']) {
    it('JSON-RPC limit ' + JSON.stringify(limit) + ' still pages with limit 5', async function () {
      const tracker = createMockTracker(sinon);
      tracker.getUtxosAddress.resolves(emptyPage());
      const res = await rpc(createTestApp(tracker), limit);
      expect(res.body.error).to.equal(undefined);
      expect(tracker.getUtxosAddress.firstCall.args[1].limit).to.equal(5);
    });
  }

  it('REST ?limit=abc answers 400', async function () {
    const tracker = createMockTracker(sinon);
    tracker.getUtxosAddress.resolves(emptyPage());
    await supertest(createTestApp(tracker)).get('/utxos/addr1').query({ limit: 'abc' }).expect(400);
    expect(tracker.getUtxosAddress.called).to.equal(false);
  });
});
