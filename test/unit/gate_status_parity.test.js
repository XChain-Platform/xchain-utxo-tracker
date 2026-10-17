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

// The tracker/bootstrap-gate seam, checked against the gate's own code.
//
// xchain-node's bootstrap health gate decides whether a node may trust this
// tracker as a bootstrap source by running evaluateStatusPayload over the
// JSON-RPC `health` answer, or over GET /status when that POST is shed. The
// tracker's own tests only pinned a hand-copied accepted-status set, so a
// renamed refusal key (block_fetch_desync, node_height_stale) would silently
// disable that refusal with every test green. These cases drive the real app
// and feed every answer to the sibling checkout's real gate: only the healthy
// shapes may pass, and every faulted shape must be refused.

const { expect } = require('chai');
const supertest = require('supertest');
const { siblingCheckout, skipOrFail } = require('../helpers/sibling_checkout.js');
const { createApp } = require('../../src/api/startup.js');
const { deriveHealthStatus, NODE_RPC_STALE_MS } = require('../../src/api.js');

const GATE_VERDICT = siblingCheckout(__dirname,
  '../../../xchain-node/src/services/bootstrap_health_gate/status_evaluation.js');

// The accepted set health_status.test.js pins; this file ties it to the live gate.
const GATE_ACCEPTED_STATUS = ['ok', 'healthy'];

function stubTracker(overrides = {}) {
  return {
    db: { getLastBlockHeight: async () => 500 },
    connector: { getBlockchainInfo: async () => ({ blocks: 500 }) },
    isSynced: () => true,
    isMempoolReconverged: () => true,
    latestKnownChainTip: 500,
    reorgCount: 0,
    lastReorgDepth: 0,
    lastNodeRpcOkAt: Date.now(),
    undoBlocks: 10,
    lastBlocks: [],
    ...overrides
  };
}

function appFor(tracker) {
  return createApp({
    tracker,
    UTXO_TRACKER_API_KEY: '',
    ADMIN_METHODS: new Set(),
    MAX_JSONRPC_BATCH: 20,
    MAX_PAGE_LIMIT: 10000,
    CORS_ORIGIN: '*',
    UTXO_TRACKER_RATE_LIMIT_RPM: 500,
    UTXO_TRACKER_MAX_CONCURRENT_PROBES: 16,
    UTXO_TRACKER_MAX_CONCURRENT_REQUESTS: 100,
    COIN: 'TEST',
    NETWORK: 'regtest',
    DB_NAME: 'xchain-utxo-tracker-gate-parity',
    keyEquals: () => false,
    installUnmatchedRouteLabel: (app) => app,
    launchTracker: () => Promise.resolve()
  });
}

async function healthAnswer(tracker) {
  const res = await supertest(appFor(tracker)).post('/')
    .send({ jsonrpc: '2.0', method: 'health', params: {}, id: 1 }).expect(200);
  expect(res.body.result, JSON.stringify(res.body)).to.be.an('object');
  return res.body.result;
}

async function statusBody(tracker) {
  const res = await supertest(appFor(tracker)).get('/status');
  return res.body;
}

const DESYNC = { height: 420, failures: 7, lastError: 'block not found', detectedAt: '2026-10-01T00:00:00.000Z' };
const throwing = async () => { throw new Error('rpc down'); };

describe('tracker health payloads judged by the real bootstrap gate', function () {
  let evaluateStatusPayload;

  before(function () {
    if (!GATE_VERDICT.usable) return skipOrFail(this, GATE_VERDICT, 'the tracker/gate status parity check');
    ({ evaluateStatusPayload } = require(GATE_VERDICT.path));
  });

  describe('status words', function () {
    it('accepts every word the tracker treats as the gate accepted set', function () {
      for (const word of GATE_ACCEPTED_STATUS) {
        expect(evaluateStatusPayload({ status: word, lag: 0 }), word).to.deep.equal([]);
      }
      expect(evaluateStatusPayload({ status: deriveHealthStatus({ halted: false, dbOk: true }), lag: 0 })).to.deep.equal([]);
    });

    it('refuses every non-healthy word the tracker emits', function () {
      for (const word of ['halted', 'unhealthy', 'degraded', 'stalled']) {
        expect(evaluateStatusPayload({ status: word, lag: 0 }), word).to.not.be.empty;
      }
    });
  });

  describe('JSON-RPC health', function () {
    it('passes a tracker at the node tip', async function () {
      expect(evaluateStatusPayload(await healthAnswer(stubTracker()))).to.deep.equal([]);
    });

    it('passes a tracker lagging inside the gate budget, above its own synced threshold', async function () {
      const answer = await healthAnswer(stubTracker({ connector: { getBlockchainInfo: async () => ({ blocks: 550 }) } }));
      expect(answer.lag).to.equal(50);
      expect(evaluateStatusPayload(answer)).to.deep.equal([]);
    });

    const refused = {
      'a halted tracker': { halted: true, haltReason: 'unrecoverable reorg' },
      'a block-fetch desync': { blockFetchDesync: DESYNC },
      'a failed live node read with a cached tip': { connector: { getBlockchainInfo: throwing } },
      'a stale sync loop': { lastNodeRpcOkAt: Date.now() - NODE_RPC_STALE_MS - 60000 },
      'an unknown node tip': { connector: { getBlockchainInfo: throwing }, latestKnownChainTip: undefined },
      'an unreachable store': { db: { getLastBlockHeight: throwing } },
    };
    for (const [name, overrides] of Object.entries(refused)) {
      it(`refuses ${name}`, async function () {
        expect(evaluateStatusPayload(await healthAnswer(stubTracker(overrides))), name).to.not.be.empty;
      });
    }

    it('refuses a desync on the desync key alone', async function () {
      const answer = await healthAnswer(stubTracker({ blockFetchDesync: DESYNC }));
      expect(evaluateStatusPayload(answer).join(' ')).to.match(/desync/);
    });

    it('refuses a stale node height on the stale key alone', async function () {
      const answer = await healthAnswer(stubTracker({ connector: { getBlockchainInfo: throwing } }));
      expect(evaluateStatusPayload(answer).join(' ')).to.match(/stale node height/);
    });
  });

});

describe('tracker health payloads judged by the real bootstrap gate', function () {
  let evaluateStatusPayload;

  before(function () {
    if (!GATE_VERDICT.usable) return skipOrFail(this, GATE_VERDICT, 'the tracker/gate status parity check');
    ({ evaluateStatusPayload } = require(GATE_VERDICT.path));
  });

  describe('GET /status fallback', function () {
    it('passes a tracker at the node tip', async function () {
      expect(evaluateStatusPayload(await statusBody(stubTracker()))).to.deep.equal([]);
    });

    const refused = {
      'a halted tracker': { halted: true, haltReason: 'unrecoverable reorg' },
      'a block-fetch desync': { blockFetchDesync: DESYNC },
      'a stale sync loop': { lastNodeRpcOkAt: Date.now() - NODE_RPC_STALE_MS - 60000 },
      'an unreachable node': { connector: { getBlockchainInfo: throwing,
        nodeReachability: () => ({ node_last_ok_at: null, node_unreachable: { since: null, last_ok_at: null, seconds: 90 } }) } },
      'an unknown node tip': { latestKnownChainTip: undefined },
      'an unreachable store': { db: { getLastBlockHeight: throwing } },
    };
    for (const [name, overrides] of Object.entries(refused)) {
      it(`refuses ${name} on the body alone`, async function () {
        expect(evaluateStatusPayload(await statusBody(stubTracker(overrides))), name).to.not.be.empty;
      });
    }

    it('refuses a desync on the desync key alone', async function () {
      const body = await statusBody(stubTracker({ blockFetchDesync: DESYNC }));
      expect(body.status).to.equal('ok');
      expect(evaluateStatusPayload(body).join(' ')).to.match(/desync/);
    });
  });
});
