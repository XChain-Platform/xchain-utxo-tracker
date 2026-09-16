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

const { deriveHealthStatus, isNodeRpcStale, deriveSyncedVerdict, NODE_RPC_STALE_MS } = require('../../src/api.js');
const XChainUtxoTracker = require('../../src/XChainUtxoTracker.js');

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

  // The helper's doc comment used to claim it mirrored xchain-decoder's health(),
  // which "likewise keeps its durable halt marker out of `status`". The decoder does
  // publish reorg_halted as its own field with `status` untouched, while this helper
  // folds halt straight into the word, so the analogy told a reader the opposite of
  // the behavior two lines below it. The tracker has no durable marker to compare
  // against at all. Guard the description instead of the comparison.
  it('documents that halt reaches the status word, without the decoder analogy', function () {
    const src = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');
    const doc = src.slice(0, src.indexOf('function deriveHealthStatus('))
      .split('\n\n').pop();
    expect(doc).to.match(/'halted'/);
    expect(doc).to.not.match(/decoder/i);
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

// GET /status used to derive liveness from a readable LevelDB plus the halt
// flag, while the tracking loop retries a failing getBlockchainInfo forever. A
// coin node that is down or unsynced froze block tracking with the store still
// readable, so the probe kept answering 'ok'.
describe('node-RPC staleness policy', function () {

  const WINDOW = 150000;

  it('is not stale inside the window', function () {
    expect(isNodeRpcStale({ lastNodeRpcOkAt: 1000, now: 1000 + WINDOW, windowMs: WINDOW })).to.equal(false);
  });

  it('is stale once the window is exceeded', function () {
    expect(isNodeRpcStale({ lastNodeRpcOkAt: 1000, now: 1001 + WINDOW, windowMs: WINDOW })).to.equal(true);
  });

  // The loop stamps the timestamp only after a usable tip read, so a process whose
  // loop has not started has no timestamp at all. Reading that as stale would 503
  // every container before its first poll.
  it('reads an unset timestamp as not-stale rather than stale', function () {
    expect(isNodeRpcStale({})).to.equal(false);
    expect(isNodeRpcStale()).to.equal(false);
    expect(isNodeRpcStale({ lastNodeRpcOkAt: null })).to.equal(false);
    expect(isNodeRpcStale({ lastNodeRpcOkAt: 'soon' })).to.equal(false);
  });

  // Five refresh cycles (BLOCKCHAIN_INFO_REFRESH_MS is 30s in XChainUtxoTracker.js),
  // so one slow or skipped poll never trips the probe.
  it('defaults to a window several refresh cycles wide', function () {
    expect(NODE_RPC_STALE_MS).to.be.at.least(120000);
  });

  // Wiring guard: the /status route is registered inside startApi()'s closure and
  // is not reachable from a require. Without this gate the staleness policy is
  // computed by nobody and the probe is DB-only again.
  it('gates GET /status on the staleness verdict', function () {
    const src = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');
    const route = src.slice(src.indexOf("app.get('/status'"));
    expect(route).to.match(/isNodeRpcStale\(/);
    expect(route).to.match(/nodeRpcStale\) res\.status\(503\)|!dbOk \|\| nodeRpcStale\) res\.status\(503\)/);
  });

  // Wiring guard: xchain-node's bootstrap gate falls back to GET /status when the
  // health POST is shed, and refuses a body with no lag field. The freshness meta
  // (lag/node_height/synced from the cached tip, no RPC) must ride on BOTH the
  // halted and the normal branch so the fallback probe is never lag-free.
  it('spreads the freshness meta into every GET /status body', function () {
    const src = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');
    const route = src.slice(src.indexOf("app.get('/status'"), src.indexOf("app.use((req, res, next) => { if (req.body === undefined)"));
    expect(route).to.match(/const freshness = await getFreshnessMeta\(committedHeight\)/);
    expect(route.match(/\.\.\.freshness/g) || []).to.have.lengthOf(2);
  });

  // Deliberate boundary: deriveHealthStatus feeds the `health` RPC, whose consumers
  // (xchain-node's bootstrap gate) own their own lag budget. Folding staleness into
  // it would refuse a source the caller would otherwise accept.
  it('keeps staleness out of the health status word', function () {
    expect(deriveHealthStatus({ halted: false, dbOk: true })).to.equal('healthy');
  });

});

// The synced verdict used to be upper-bounded only. A node reset/reindex below
// our committed tip yields a NEGATIVE lag, which read synced:true and authorized
// PSBT selection over UTXOs in blocks the node no longer recognizes; both encoder
// gates delegate this verdict, so the floor has to live here.
describe('sync verdict bounds', function () {

  const THRESHOLD = XChainUtxoTracker.SYNCED_THRESHOLD;

  it('is synced from lag 0 up to and including the threshold', function () {
    expect(deriveSyncedVerdict({ lag: 0, threshold: THRESHOLD })).to.equal(true);
    expect(deriveSyncedVerdict({ lag: THRESHOLD, threshold: THRESHOLD })).to.equal(true);
  });

  it('is not synced above the threshold', function () {
    expect(deriveSyncedVerdict({ lag: THRESHOLD + 1, threshold: THRESHOLD })).to.equal(false);
  });

  // The regression this exists for: committed 1000 against a node reset to 900.
  it('is not synced when the tracker is AHEAD of the node', function () {
    expect(deriveSyncedVerdict({ lag: -100, threshold: THRESHOLD })).to.equal(false);
    expect(deriveSyncedVerdict({ lag: -1, threshold: THRESHOLD })).to.equal(false);
  });

  // A frozen cached tip can read lag 0 while the live chain has run far ahead.
  it('is not synced while the node height is stale', function () {
    expect(deriveSyncedVerdict({ lag: 0, nodeHeightStale: true, threshold: THRESHOLD })).to.equal(false);
  });

  it('treats an unknown lag as not synced, never as lag 0', function () {
    expect(deriveSyncedVerdict({ lag: null, threshold: THRESHOLD })).to.equal(false);
    expect(deriveSyncedVerdict({ threshold: THRESHOLD })).to.equal(false);
    expect(deriveSyncedVerdict()).to.equal(false);
  });

  // Wiring guard: get_sync_status is built inside startApi()'s closure and is not
  // reachable from a require, so an unwired helper would leave the old inline
  // expression in force with every test above still green.
  it('computes get_sync_status.synced from the helper', function () {
    const src = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');
    const method = src.slice(src.indexOf('async get_sync_status()'));
    expect(method).to.match(/synced:\s*deriveSyncedVerdict\(\{ lag, nodeHeightStale \}\)/);
  });

  // get_sync_status is the ONLY tracker surface the encoder's serve-readiness
  // probe reads, so without mempool_ready here that probe cannot mirror create_tx's
  // UTXO_TRACKER_NOT_READY refusal and /status paints the encoder healthy through the
  // whole restart window in which every create_tx is refused. Same closure problem as
  // the guard above, so the same source-level assertion.
  it('publishes mempool_ready on get_sync_status, floored by the same synced verdict', function () {
    const src = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');
    const method = src.slice(src.indexOf('async get_sync_status()'));
    expect(method).to.match(
      /result\.mempool_ready\s*=\s*result\.synced\s*&&\s*tracker\.isMempoolReconverged\(\)\s*===\s*true/
    );
  });

});
