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
const { isQuiescent, configureQuiescenceDeadlineMs } = require('../../../src/api/quiescence');
const { createTestApp, createMockTracker } = require('./support/test_app');

function trackerWith(connector, height = 100) {
  return { connector, db: { getLastBlockHeight: sinon.stub().resolves(height) } };
}

function hungConnector() {
  const resolvers = [];
  const hang = () => new Promise((resolve) => { resolvers.push(resolve); });
  return {
    resolvers,
    getRawMempool: sinon.spy(hang),
    getBlockchainInfo: sinon.spy(hang)
  };
}

function registerAnswerTests() {
  describe('is_quiescent answers', function () {
    it('is ready when the mempool is empty and the node tip equals the committed height', async function () {
      const connector = {
        getRawMempool: sinon.stub().resolves([]),
        getBlockchainInfo: sinon.stub().resolves({ blocks: 100 })
      };
      const out = await isQuiescent(trackerWith(connector));
      expect(out).to.include({ ready: true, mempool_size: 0, node_height: 100, committed_height: 100, lag: 0 });
    });

    it('is not ready with a non-empty mempool or a lagging tracker', async function () {
      const busy = trackerWith({
        getRawMempool: sinon.stub().resolves(['a'.repeat(64)]),
        getBlockchainInfo: sinon.stub().resolves({ blocks: 100 })
      });
      expect(await isQuiescent(busy)).to.include({ ready: false, mempool_size: 1 });

      const lagging = trackerWith({
        getRawMempool: sinon.stub().resolves([]),
        getBlockchainInfo: sinon.stub().resolves({ blocks: 103 })
      });
      expect(await isQuiescent(lagging)).to.include({ ready: false, lag: 3 });
    });

    it('reports -1 for a leg whose node read failed and never reads ready', async function () {
      const connector = {
        getRawMempool: sinon.stub().rejects(new Error('node down')),
        getBlockchainInfo: sinon.stub().resolves({ blocks: 100 })
      };
      expect(await isQuiescent(trackerWith(connector))).to.include({ ready: false, mempool_size: -1, node_height: 100 });
    });
  });
}

function registerBoundTests() {
  describe('is_quiescent against a node that never answers', function () {
    it('answers not-ready at the deadline instead of waiting on the node', async function () {
      const connector = hungConnector();
      const started = Date.now();
      const out = await isQuiescent(trackerWith(connector), 30);
      expect(Date.now() - started).to.be.below(1000);
      expect(out).to.include({ ready: false, mempool_size: -1, node_height: -1 });
    });

    it('issues the same two node reads whether one caller or fifty arrive while a probe is outstanding', async function () {
      const connector = hungConnector();
      const tracker = trackerWith(connector);
      const first = isQuiescent(tracker, 30);
      const crowd = await Promise.all(Array.from({ length: 49 }, () => isQuiescent(tracker, 30)));
      await first;
      expect(connector.getRawMempool.callCount).to.equal(1);
      expect(connector.getBlockchainInfo.callCount).to.equal(1);
      for (const out of crowd) expect(out.ready).to.equal(false);
    });

    it('probes again only after the outstanding node reads settle', async function () {
      const connector = hungConnector();
      const tracker = trackerWith(connector);
      await isQuiescent(tracker, 20);
      connector.resolvers.forEach((resolve) => resolve([]));
      await new Promise((resolve) => setImmediate(resolve));
      await isQuiescent(tracker, 20);
      expect(connector.getRawMempool.callCount).to.equal(2);
      expect(connector.getBlockchainInfo.callCount).to.equal(2);
    });

    it('holds a JSON-RPC batch of is_quiescent entries to one probe against a hung node', async function () {
      const connector = hungConnector();
      const mock = createMockTracker(sinon);
      mock.connector = connector;
      const batch = Array.from({ length: 20 }, (_, i) => ({ jsonrpc: '2.0', method: 'is_quiescent', id: i }));
      configureQuiescenceDeadlineMs(40);
      const started = Date.now();
      const res = await supertest(createTestApp(mock)).post('/').send(batch).expect(200);
      expect(res.body).to.have.length(20);
      expect(res.body.every((r) => r.result.ready === false)).to.equal(true);
      expect(connector.getRawMempool.callCount).to.equal(1);
      expect(Date.now() - started).to.be.below(2000);
    });
  });
}

describe('is_quiescent bounded probe', function () {
  afterEach(function () {
    sinon.restore();
    configureQuiescenceDeadlineMs(5000);
  });
  registerAnswerTests();
  registerBoundTests();
});
