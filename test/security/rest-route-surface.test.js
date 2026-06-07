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

// ─── Security: REST address routes pass untrusted input straight through ──────
//
// The four GET /…/:address routes (api.js) take `req.params.address` verbatim
// and hand it to the tracker — there is NO length cap, charset allowlist, or
// schema check at the HTTP edge; the only validation is toOutputScript deep
// inside the tracker (covered by address-validation.test.js). These tests
// reconstruct the real routes (mirroring unit/api.test.js) and pin:
//   • the X-Mempool-Ready readiness-header contract, and
//   • that arbitrary attacker bytes reach the tracker unmodified — quantifying
//     the input surface the validation gate must therefore be trusted to hold.
//
// NB the production routes delegate all address validation to the tracker layer
// (toOutputScript). The error-handling shape of that delegation is reviewed
// separately; these tests focus on the readiness-header contract and the
// unmodified-passthrough property, which are deterministic.

const { expect } = require('chai');
const sinon = require('sinon');
const express = require('express');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const cors = require('cors');
const supertest = require('supertest');

// Build the app with the SAME route bodies as src/api.js (verbatim), backed by a
// mock tracker so we can observe exactly what the HTTP layer forwards.
function createRealRoutesApp(tracker) {
  const app = express();
  app.use(helmet());
  app.use(bodyParser.json());
  app.use(cors());

  app.get('/utxos/:address', async (req, res) => {
    const address = req.params.address;
    const utxos = await tracker.getUtxosAddress(address);
    res.set('X-Mempool-Ready', String(tracker.isSynced()));
    res.send(utxos);
  });

  app.get('/balance/:address', async (req, res) => {
    const address = req.params.address;
    const utxos = await tracker.getUtxosAddress(address);
    let balance = 0;
    for (const u of utxos) balance += u.amount;
    res.set('X-Mempool-Ready', String(tracker.isSynced()));
    res.send(String(balance));
  });

  app.get('/info/:address', async (req, res) => {
    const address = req.params.address;
    const info = await tracker.getBalanceInfo(address);
    const mempoolReady = tracker.isSynced();
    res.set('X-Mempool-Ready', String(mempoolReady));
    if (info && typeof info === 'object') info.mempool_ready = mempoolReady;
    res.send(info);
  });

  return app;
}

describe('Security: REST address-route input surface', function () {
  let tracker;
  let app;

  beforeEach(function () {
    tracker = {
      getUtxosAddress: sinon.stub().resolves([]),
      getBalanceInfo: sinon.stub().resolves({ address: 'x', balances: { confirmed: '0.00000000' } }),
      isSynced: sinon.stub().returns(true),
    };
    app = createRealRoutesApp(tracker);
  });

  it('exposes X-Mempool-Ready=true when the tracker is synced', async function () {
    const res = await supertest(app).get('/utxos/anyaddr').expect(200);
    expect(res.headers['x-mempool-ready']).to.equal('true');
  });

  it('exposes X-Mempool-Ready=false when the mempool is still reconverging', async function () {
    tracker.isSynced.returns(false);
    const res = await supertest(app).get('/balance/anyaddr').expect(200);
    expect(res.headers['x-mempool-ready']).to.equal('false');
  });

  it('/info adds an additive mempool_ready field without dropping the body', async function () {
    const res = await supertest(app).get('/info/anyaddr').expect(200);
    expect(res.body).to.have.property('mempool_ready', true);
    expect(res.body).to.have.property('balances');
  });

  it('forwards attacker-controlled :address bytes to the tracker unmodified (no HTTP-edge validation)', async function () {
    // A long, special-character-laden segment. Express URL-decodes the segment,
    // and the route passes it straight to the tracker — proving the only
    // validation is the tracker's toOutputScript gate, not the HTTP layer.
    const hostile = 'A'.repeat(300) + "_'%3B--";
    await supertest(app).get('/utxos/' + encodeURIComponent(hostile)).expect(200);
    expect(tracker.getUtxosAddress.calledOnce).to.equal(true);
    expect(tracker.getUtxosAddress.firstCall.args[0]).to.equal(hostile);
  });

  it('does not coerce or trim whitespace/control characters before the tracker', async function () {
    const spaced = '  mWeird\tAddr  ';
    await supertest(app).get('/balance/' + encodeURIComponent(spaced)).expect(200);
    expect(tracker.getUtxosAddress.firstCall.args[0]).to.equal(spaced);
  });
});
