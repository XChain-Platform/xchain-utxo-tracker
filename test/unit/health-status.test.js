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
const fs = require('fs');
const path = require('path');

const { deriveHealthStatus } = require('../../src/api.js');

// xchain-node's BootstrapHealthGate.evaluateStatusPayload refuses any payload
// whose `status` is outside this set, so a status word the tracker invents
// outside it silently refuses every bootstrap from this tracker.
const GATE_ACCEPTED_STATUS = ['ok', 'healthy'];

describe('health status policy', function () {

  it('reports healthy only when the store is reachable', function () {
    expect(deriveHealthStatus({ halted: false, dbOk: true })).to.equal('healthy');
    expect(deriveHealthStatus({ halted: false, dbOk: false })).to.equal('unhealthy');
  });

  it('reports halted regardless of store reachability', function () {
    expect(deriveHealthStatus({ halted: true, dbOk: true })).to.equal('halted');
    expect(deriveHealthStatus({ halted: true, dbOk: false })).to.equal('halted');
  });

  it('fails closed on a missing argument rather than defaulting to healthy', function () {
    expect(deriveHealthStatus()).to.equal('unhealthy');
    expect(deriveHealthStatus({})).to.equal('unhealthy');
  });

  it('emits a status word the consuming bootstrap gate accepts when reachable', function () {
    expect(GATE_ACCEPTED_STATUS).to.include(deriveHealthStatus({ halted: false, dbOk: true }));
  });

  // Lag never reaches `status`: the gate allows 100 blocks while the tracker's
  // own SYNCED_THRESHOLD is 3, so a lag-derived status would refuse a source the
  // gate would have accepted. Lag travels as its own field instead.
  it('ignores sync position entirely', function () {
    expect(deriveHealthStatus({ halted: false, dbOk: true, synced: false, lag: 9999 }))
      .to.equal('healthy');
  });

  // Wiring guard: jsonRpcController is built inside startApi()'s closure and is
  // not reachable from a require, so the method's registration is asserted at
  // the source level. Without a registered `health`, the gate's first probe gets
  // method-not-found and falls back to /status, which carries no lag at all.
  it('registers health on the JSON-RPC controller', function () {
    const src = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');
    const controller = src.slice(src.indexOf('const jsonRpcController = {'));
    expect(controller).to.match(/^\s+async health\(\)\s*\{/m);
    expect(controller).to.match(/deriveHealthStatus\(/);
  });

});
