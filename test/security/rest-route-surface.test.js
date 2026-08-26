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

// Security: REST address routes pass untrusted input straight through.
//
// The four GET /…/:address routes (api.js) take `req.params.address` verbatim
// and hand it to the tracker. There is NO length cap, charset allowlist, or
// schema check at the HTTP edge; the only validation is toOutputScript deep
// inside the tracker (covered by address-validation.test.js). These tests
// reconstruct the real routes (mirroring unit/api.test.js) and pin:
//   • the X-Mempool-Ready readiness-header contract, and
//   • that arbitrary attacker bytes reach the tracker unmodified, quantifying
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
const XChainUtxoTracker = require('../../src/XChainUtxoTracker');

// Mirrors src/api.js's setFreshnessHeaders, and deliberately calls the REAL
// computeFreshness rather than restating its verdict: that static is where the
// negative-lag floor lives, so a copy of the rule here could drift back to the
// raw isSynced() flag with no assertion noticing.
async function setFreshnessHeaders(res, tracker) {
  let committedHeight = -1;
  try { committedHeight = await tracker.db.getLastBlockHeight(); } catch (e) {}
  const rawTip = (typeof tracker.latestKnownChainTip === 'number') ? tracker.latestKnownChainTip : -1;
  const f = XChainUtxoTracker.computeFreshness(committedHeight, rawTip, tracker.isSynced(), {
    mempoolReconverged: tracker.isMempoolReconverged()
  });
  res.set('X-Tracker-Height', String(f.tracker_height));
  res.set('X-Node-Height', String(f.node_height));
  if (f.lag !== null) res.set('X-Sync-Lag', String(f.lag));
  res.set('X-Synced', String(f.synced));
  return f;
}

// Stand-in app carrying the readiness and passthrough behaviour of src/api.js's
// address routes. The middleware stack and the /balance body shape are NOT
// production's, so read the two properties this file names and nothing wider.
function createRealRoutesApp(tracker) {
  const app = express();
  app.use(helmet());
  app.use(bodyParser.json());
  app.use(cors());

  app.get('/utxos/:address', async (req, res) => {
    const address = req.params.address;
    const utxos = await tracker.getUtxosAddress(address);
    const freshness = await setFreshnessHeaders(res, tracker);
    res.set('X-Mempool-Ready', String(freshness.mempool_ready));
    res.send(utxos);
  });

  app.get('/balance/:address', async (req, res) => {
    const address = req.params.address;
    const utxos = await tracker.getUtxosAddress(address);
    let balance = 0;
    for (const u of utxos) balance += u.amount;
    const freshness = await setFreshnessHeaders(res, tracker);
    res.set('X-Mempool-Ready', String(freshness.mempool_ready));
    res.send(String(balance));
  });

  app.get('/info/:address', async (req, res) => {
    const address = req.params.address;
    const info = await tracker.getBalanceInfo(address);
    const freshness = await setFreshnessHeaders(res, tracker);
    res.set('X-Mempool-Ready', String(freshness.mempool_ready));
    if (info && typeof info === 'object') info.mempool_ready = freshness.mempool_ready;
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
      isMempoolReconverged: sinon.stub().returns(true),
      latestKnownChainTip: 100,
      db: { getLastBlockHeight: sinon.stub().resolves(100) },
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

  it('floors X-Mempool-Ready to false on an orphaned view, isSynced() notwithstanding', async function () {
    // Committed tip ABOVE the node's: the node reindexed or reset underneath us,
    // so the outputs this view would authorize sit in blocks the node no longer
    // recognizes. The raw isSynced() flag is height-catchup state and knows
    // nothing of that, which is why the header comes off the floored verdict.
    tracker.db.getLastBlockHeight.resolves(120);
    tracker.latestKnownChainTip = 100;
    const res = await supertest(app).get('/utxos/anyaddr').expect(200);
    expect(res.headers['x-synced']).to.equal('false');
    expect(res.headers['x-mempool-ready']).to.equal('false');
  });

  it('exposes X-Mempool-Ready=false while the mempool has not reconverged', async function () {
    tracker.isMempoolReconverged.returns(false);
    const res = await supertest(app).get('/utxos/anyaddr').expect(200);
    expect(res.headers['x-synced']).to.equal('true');
    expect(res.headers['x-mempool-ready']).to.equal('false');
  });

  it('/info adds an additive mempool_ready field without dropping the body', async function () {
    const res = await supertest(app).get('/info/anyaddr').expect(200);
    expect(res.body).to.have.property('mempool_ready', true);
    expect(res.body).to.have.property('balances');
  });

  it('forwards attacker-controlled :address bytes to the tracker unmodified (no HTTP-edge validation)', async function () {
    // A long, special-character-laden segment. Express URL-decodes the segment,
    // and the route passes it straight to the tracker, proving the only
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
