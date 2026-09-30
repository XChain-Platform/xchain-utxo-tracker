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
const { statusRefusalFields, NODE_RPC_STALE_MS } = require('../../../src/api/sync_status.js');

// Every refusal key xchain-node's bootstrap gate reads off the JSON-RPC `health`
// answer must also ride GET /status, because that route is the gate's fallback
// probe whenever the `health` POST is shed. A body missing a key the gate refuses
// on passes a desynced or node-blind tracker as a bootstrap source.
const GATE_REFUSAL_KEYS = ['block_fetch_desync', 'node_height_stale'];

const DESYNC = { height: 5342110, failures: 20, lastError: 'Block not found', detectedAt: 1759100000000 };
const OUTAGE = { since: '2026-09-29T00:00:00.000Z', last_ok_at: '2026-09-29T00:00:00.000Z', seconds: 200 };

// A tracker the two surfaces read the same way: `nodeDown` fails the live tip
// read `health` makes and marks the connector's cached reachability failing.
// `loopOkAt` sets the sync loop's last usable tip read (null: loop not started).
function trackerIn({ desync = null, nodeDown = false, halted = false, loopOkAt = Date.now() } = {}) {
  const tracker = createMockTracker(sinon);
  Object.assign(tracker, {
    blockFetchDesync: desync,
    lastNodeRpcOkAt: loopOkAt,
    reorgCount: 0,
    lastReorgDepth: 0,
    undoBlocks: 100,
    lastBlocks: [],
    mempoolRpcFailures: 0,
    halted,
    haltReason: halted ? 'unrecoverable reorg' : null,
    haltedAt: halted ? '2026-09-29T00:00:00.000Z' : null,
    haltedHeight: halted ? 100 : null,
    connector: {
      getBlockchainInfo: nodeDown ? sinon.stub().rejects(new Error('ECONNREFUSED')) : sinon.stub().resolves({ blocks: 100 }),
      nodeReachability: () => ({ node_last_ok_at: OUTAGE.last_ok_at, node_unreachable: nodeDown ? OUTAGE : null })
    }
  });
  return tracker;
}

async function bothSurfaces(tracker) {
  const app = createTestApp(tracker);
  const health = await supertest(app).post('/').set('Content-Type', 'application/json')
    .send({ jsonrpc: '2.0', method: 'health', id: 1 });
  const status = await supertest(app).get('/status');
  return { health: health.body.result, status: status.body, statusCode: status.status };
}

describe('GET /status carries the same gate-refusal keys as health', function () {
  afterEach(function () { sinon.restore(); });

  it('carries block_fetch_desync on both surfaces, deep-equal', async function () {
    const { health, status, statusCode } = await bothSurfaces(trackerIn({ desync: DESYNC }));
    expect(statusCode).to.equal(200);
    expect(health.block_fetch_desync).to.deep.equal(DESYNC);
    expect(status.block_fetch_desync).to.deep.equal(DESYNC);
  });

  it('carries node_height_stale on both surfaces while the node is failing', async function () {
    const { health, status, statusCode } = await bothSurfaces(trackerIn({ nodeDown: true }));
    // A sub-threshold outage: /status still answers 200, which is the window the gate reads.
    expect(statusCode).to.equal(200);
    expect(health.node_height_stale).to.equal(true);
    expect(status.node_height_stale).to.equal(true);
  });

  it('carries both keys on the halted 503 branch too', async function () {
    const { health, status, statusCode } = await bothSurfaces(trackerIn({ desync: DESYNC, nodeDown: true, halted: true }));
    expect(statusCode).to.equal(503);
    expect(status.status).to.equal('halted');
    for (const key of GATE_REFUSAL_KEYS) {
      expect(health, `health ${key}`).to.have.property(key);
      expect(status, `/status ${key}`).to.have.property(key);
    }
  });

  it('leaves both keys off both surfaces for a healthy tracker', async function () {
    const { health, status, statusCode } = await bothSurfaces(trackerIn());
    expect(statusCode).to.equal(200);
    for (const key of GATE_REFUSAL_KEYS) {
      expect(health, `health ${key}`).to.not.have.property(key);
      expect(status, `/status ${key}`).to.not.have.property(key);
    }
  });

  it('marks health stale with the loop stuck even while its own live read succeeds', async function () {
    const { health, status, statusCode } = await bothSurfaces(trackerIn({ loopOkAt: Date.now() - NODE_RPC_STALE_MS - 1000 }));
    expect(statusCode).to.equal(503);
    expect(status.node_height_stale).to.equal(true);
    expect(health.node_height_stale).to.equal(true);
    expect(health.node_rpc_stale).to.equal(true);
    expect(health.synced).to.equal(false);
    expect(health.lag).to.be.a('number');
  });

  it('leaves health unflagged before the loop has read its first tip', async function () {
    const { health } = await bothSurfaces(trackerIn({ loopOkAt: null }));
    expect(health).to.not.have.property('node_height_stale');
    expect(health).to.not.have.property('node_rpc_stale');
  });

  it('marks the node height stale once the loop tip read itself has gone stale', function () {
    expect(statusRefusalFields({}, { node_unreachable: null }, true)).to.deep.equal({ node_height_stale: true });
    expect(statusRefusalFields(undefined, undefined)).to.deep.equal({});
  });
});
