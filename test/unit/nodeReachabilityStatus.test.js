'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// A node that never answered, made visible.
//
// An operator ran a service whose coin node answered no RPC at all: the log carried
// the same timeout line 2099 times over five and a half days, the restart count
// stayed 0 and the container healthcheck read healthy throughout. Nothing on any
// surface said the service had never reached its node.
//
// The healthy VERDICT is unchanged here: a restart cannot fix an upstream outage and
// gating on one re-opens the autoheal restart flap. What these pin is the VISIBILITY:
// the connector records when the node last answered and when it last failed,
// nodeReachability() reduces those to node_last_ok_at and node_unreachable, and both
// ride every surface that already carries node_catching_up.

const { expect } = require('chai');
const sinon = require('sinon');
const fs = require('fs');
const path = require('path');
const BlockchainConnector = require('../../src/BlockchainConnector');
const { nodeReachabilityFrom } = BlockchainConnector;
const { nodeReachabilityFields } = require('../../src/api');

const T0   = Date.parse('2026-09-09T12:00:00.000Z');  // connector construction
const OK   = Date.parse('2026-09-09T12:10:00.000Z');
const FAIL = Date.parse('2026-09-09T12:20:00.000Z');
const NOW  = Date.parse('2026-09-09T13:00:00.000Z');

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('XChainUtxoTracker: node reachability is visible on the health surfaces', function () {
  this.timeout(0);

  const connectorSrc = fs.readFileSync(path.join(__dirname, '../../src/BlockchainConnector.js'), 'utf8');
  const apiSrc = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');

  function newConnector() {
    return new BlockchainConnector('127.0.0.1', '18443', 'user', 'pass');
  }

  describe('nodeReachabilityFrom() (the reducer both fields are derived from)', function () {
    it('reports nothing wrong before any attempt has been made', function () {
      expect(nodeReachabilityFrom(T0, 0, 0, NOW)).to.deep.equal({
        node_last_ok_at: null, node_unreachable: null
      });
    });

    it('reports the last success and no outage while the latest attempt succeeded', function () {
      const r = nodeReachabilityFrom(T0, OK, 0, NOW);
      expect(r.node_last_ok_at).to.equal('2026-09-09T12:10:00.000Z');
      expect(r.node_unreachable).to.equal(null);
    });

    it('dates an outage from the last success when there was one', function () {
      const r = nodeReachabilityFrom(T0, OK, FAIL, NOW);
      expect(Object.keys(r.node_unreachable).sort()).to.deep.equal(['last_ok_at', 'seconds', 'since']);
      expect(r.node_unreachable.since).to.equal('2026-09-09T12:10:00.000Z');
      expect(r.node_unreachable.last_ok_at).to.equal('2026-09-09T12:10:00.000Z');
      expect(r.node_unreachable.seconds).to.equal(3000);
      expect(r.node_last_ok_at).to.equal('2026-09-09T12:10:00.000Z');
    });

    it('dates an outage from connector start when the node NEVER answered', function () {
      // The reported defect: no success to date the outage from, so the age is the
      // life of the connector, and last_ok_at stays null rather than inventing one.
      const r = nodeReachabilityFrom(T0, 0, FAIL, NOW);
      expect(r.node_last_ok_at).to.equal(null);
      expect(r.node_unreachable.since).to.equal('2026-09-09T12:00:00.000Z');
      expect(r.node_unreachable.last_ok_at).to.equal(null);
      expect(r.node_unreachable.seconds).to.equal(3600);
    });

    it('clears the outage as soon as one attempt succeeds again', function () {
      const later = FAIL + 60000;
      const r = nodeReachabilityFrom(T0, later, FAIL, NOW);
      expect(r.node_unreachable, 'a recovered node must not stay latched as unreachable').to.equal(null);
      expect(r.node_last_ok_at).to.equal(new Date(later).toISOString());
    });

    it('treats a failure at the same instant as the last success as recovered', function () {
      // Strictly-newer, not newer-or-equal: two events in one millisecond must not
      // flip a node that is answering into an outage with a zero-second age.
      expect(nodeReachabilityFrom(T0, OK, OK, NOW).node_unreachable).to.equal(null);
    });

    it('floors the age to whole seconds and never publishes a negative one', function () {
      expect(nodeReachabilityFrom(T0, 0, FAIL, T0 + 1999).node_unreachable.seconds).to.equal(1);
      expect(nodeReachabilityFrom(T0, 0, FAIL, T0 - 5000).node_unreachable.seconds,
        'a probe racing the recorded instant must not report a negative outage').to.equal(0);
    });

    it('emits ISO instants, not locale strings or epoch numbers', function () {
      const r = nodeReachabilityFrom(T0, OK, FAIL, NOW);
      expect(r.node_last_ok_at).to.match(ISO);
      expect(r.node_unreachable.since).to.match(ISO);
      expect(new Date(r.node_unreachable.since).toISOString()).to.equal(r.node_unreachable.since);
    });

    it('defaults `now` to the wall clock, so a caller cannot forget to pass one', function () {
      const clock = sinon.useFakeTimers(new Date('2026-09-09T00:00:10.000Z'));
      try {
        const r = nodeReachabilityFrom(Date.now() - 10000, 0, Date.now());
        expect(r.node_unreachable.seconds).to.equal(10);
      } finally {
        clock.restore();
      }
    });
  });

  describe('the connector records both instants at its single POST choke point', function () {
    it('starts with never-succeeded, never-failed and a start time', function () {
      const c = newConnector();
      expect(c.lastNodeOkAt).to.equal(0);
      expect(c.lastNodeFailAt).to.equal(0);
      expect(c.startedAt, 'the outage of a node that never answered is dated from here').to.be.greaterThan(0);
      expect(c.nodeReachability()).to.deep.equal({ node_last_ok_at: null, node_unreachable: null });
    });

    it('a successful POST stamps lastNodeOkAt and clears the verdict', async function () {
      const c = newConnector();
      c.lastNodeFailAt = Date.now() - 1000;
      const stub = sinon.stub(c.client, 'post').resolves({ data: { result: 'ok' } });
      try {
        await c.rpcPost({ method: 'getblockchaininfo' });
      } finally {
        stub.restore();
      }
      expect(c.lastNodeOkAt).to.be.greaterThan(0);
      expect(c.nodeReachability().node_unreachable).to.equal(null);
    });

    it('a failing POST stamps lastNodeFailAt and rethrows the original error', async function () {
      const c = newConnector();
      const boom = new Error('timeout of 30000ms exceeded');
      boom.code = 'ECONNABORTED';
      const stub = sinon.stub(c.client, 'post').rejects(boom);
      let caught = null;
      try {
        await c.rpcPost({ method: 'getblockchaininfo' });
      } catch (err) {
        caught = err;
      } finally {
        stub.restore();
      }
      expect(caught && caught.code, 'the caller ladders still classify on error.code').to.equal('ECONNABORTED');
      expect(c.lastNodeFailAt).to.be.greaterThan(0);
      const r = c.nodeReachability();
      expect(r.node_last_ok_at, 'this node has never answered').to.equal(null);
      expect(r.node_unreachable, 'the timeout the operator saw 2099 times must show here').to.not.equal(null);
      expect(r.node_unreachable.last_ok_at).to.equal(null);
    });

    it('records a success reached through a real RPC method, not only through rpcPost', async function () {
      const c = newConnector();
      const stub = sinon.stub(c.client, 'post').resolves({ data: { result: { blocks: 42 } } });
      try {
        await c.getBlockchainInfo();
      } finally {
        stub.restore();
      }
      expect(c.lastNodeOkAt).to.be.greaterThan(0);
      expect(c.nodeReachability().node_unreachable).to.equal(null);
    });

    it('every RPC method reaches the recording site through rpcPost', function () {
      // Source-level: instrumenting per method is how the next added method silently
      // escapes the surface. Nothing in this class may POST around the choke point,
      // batch helpers included.
      const posts = connectorSrc.match(/this\.client\.post\(/g) || [];
      expect(posts, 'this.client.post must appear only inside rpcPost').to.have.lengthOf(1);
      const at = connectorSrc.indexOf('async rpcPost(data) {');
      expect(at).to.be.greaterThan(0);
      expect(connectorSrc.indexOf('this.client.post(')).to.be.greaterThan(at);
    });
  });

  // api.js builds its payloads inside startApi() against a live tracker, so the wiring
  // is guarded at source level, the shape nodeCatchingUpStatus.test.js uses.
  describe('the api payloads carry node_last_ok_at and node_unreachable', function () {
    it('rides the per-query freshness meta, which both GET /status branches spread', function () {
      const at = apiSrc.indexOf('async function getFreshnessMeta(');
      expect(at).to.be.greaterThan(0);
      const body = apiSrc.slice(at, apiSrc.indexOf('async function setFreshnessHeaders', at));
      expect(body).to.match(/const reach = nodeReachabilityFields\(tracker\);/);
      expect(body).to.match(/freshness\.node_last_ok_at\s+= reach\.node_last_ok_at;/);
      expect(body).to.match(/freshness\.node_unreachable = reach\.node_unreachable;/);

      const route = apiSrc.indexOf("app.get('/status'");
      expect(route).to.be.greaterThan(0);
      const routeBody = apiSrc.slice(route, route + 3000);
      expect(routeBody).to.match(/const freshness = await getFreshnessMeta\(committedHeight\)/);
      // The halted branch and the ok branch, both spreading the same meta.
      expect(routeBody.match(/\.\.\.freshness/g) || []).to.have.length.of.at.least(2);
    });

    it('rides get_sync_status, which the JSON-RPC health answer spreads', function () {
      const at = apiSrc.indexOf('async get_sync_status()');
      expect(at).to.be.greaterThan(0);
      const syncBody = apiSrc.slice(at, apiSrc.indexOf('async health()', at));
      expect(syncBody).to.match(/const reach = nodeReachabilityFields\(tracker\);/);
      expect(syncBody).to.match(/result\.node_last_ok_at\s+= reach\.node_last_ok_at;/);
      expect(syncBody).to.match(/result\.node_unreachable = reach\.node_unreachable;/);

      const health = apiSrc.indexOf('async health()');
      const healthBody = apiSrc.slice(health, health + 900);
      expect(healthBody).to.match(/const sync = await jsonRpcController\.get_sync_status\(\)/);
      expect(healthBody).to.match(/\.\.\.sync/);
    });

    it('sits beside node_catching_up on every surface that carries it', function () {
      const sites = [];
      for (let at = apiSrc.indexOf('node_catching_up ='); at !== -1; at = apiSrc.indexOf('node_catching_up =', at + 1)) sites.push(at);
      expect(sites, 'the freshness meta and get_sync_status').to.have.lengthOf(2);
      for (const at of sites) {
        expect(apiSrc.slice(at, at + 900)).to.match(/nodeReachabilityFields\(tracker\)/);
      }
    });

    it('reads the fields fail-soft, so a payload built without a connector cannot throw', function () {
      const unknown = { node_last_ok_at: null, node_unreachable: null };
      expect(nodeReachabilityFields(undefined)).to.deep.equal(unknown);
      expect(nodeReachabilityFields({})).to.deep.equal(unknown);
      expect(nodeReachabilityFields({ connector: {} })).to.deep.equal(unknown);
      expect(nodeReachabilityFields({ connector: { nodeReachability() { throw new Error('boom'); } } }))
        .to.deep.equal(unknown);
    });

    it('reports a live connector through the helper the payloads use', function () {
      const c = newConnector();
      c.startedAt = Date.now() - 3600000;
      c.lastNodeFailAt = Date.now();
      const fields = nodeReachabilityFields({ connector: c });
      expect(fields.node_last_ok_at).to.equal(null);
      expect(fields.node_unreachable.last_ok_at).to.equal(null);
      expect(fields.node_unreachable.seconds).to.be.at.least(3599);
      expect(fields.node_unreachable.since).to.match(ISO);
    });
  });
});
