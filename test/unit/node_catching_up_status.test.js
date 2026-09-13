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

const { expect } = require('chai');
const sinon = require('sinon');
const fs = require('fs');
const path = require('path');
const XChainUtxoTracker = require('../../src/XChainUtxoTracker');
const { catchUpWaitState } = XChainUtxoTracker;

// The initial-block-download wait (nodeCatchUpWait.test.js covers the decision to
// wait) is silent past one latched log line: the tracker stops advancing and every
// health surface still reads "ok, lag N". An operator watching `xchain-node ps` sees
// a tracker that looks stalled. So the wait is published as `node_catching_up` on the
// instance and on both health payloads, and reads null the rest of the time.
describe('XChainUtxoTracker: the catch-up wait is visible on the health surfaces', function () {
  this.timeout(0);

  const trackerSrc = fs.readFileSync(path.join(__dirname, '../../src/XChainUtxoTracker.js'), 'utf8');
  const apiSrc = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');

  function newTracker() {
    return new XChainUtxoTracker(
      'bitcoin-regtest', '127.0.0.1', '18443', 'user', 'pass', 'test-db', false
    );
  }

  describe('the field on the instance', function () {
    it('is null on a fresh tracker, so "not waiting" is the default', function () {
      expect(newTracker().nodeCatchingUp).to.equal(null);
    });

    it('is initialised in the constructor, not left undefined until the first wait', function () {
      expect(Object.prototype.hasOwnProperty.call(newTracker(), 'nodeCatchingUp')).to.equal(true);
    });
  });

  describe('catchUpWaitState() (the value the wait branch publishes each poll)', function () {
    it('carries exactly the three keys, with an ISO timestamp', function () {
      const state = catchUpWaitState(null, 900123, 900456);
      expect(Object.keys(state).sort()).to.deep.equal(['node_height', 'since', 'stored_height']);
      expect(state.node_height).to.equal(900123);
      expect(state.stored_height).to.equal(900456);
      expect(state.since).to.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(new Date(state.since).toISOString()).to.equal(state.since);
    });

    it('refreshes the heights but holds `since` across two polls of the same wait', function () {
      const first = catchUpWaitState(null, 900123, 900456);
      const second = catchUpWaitState(first, 900200, 900456);
      expect(second.since, 'since ages the WAIT, not the poll').to.equal(first.since);
      expect(second.node_height).to.equal(900200);
      expect(second.stored_height).to.equal(900456);
    });

    it('stamps a new `since` for a wait that starts after one ended', function () {
      // A wait that ends sets the field back to null, which is what a later wait is
      // handed: without that reset the second wait would report the first one's age.
      // Fake clock because two real calls land in the same millisecond.
      const clock = sinon.useFakeTimers(new Date('2026-09-08T00:00:00.000Z'));
      try {
        const first = catchUpWaitState(null, 900123, 900456);
        clock.tick(60000);
        const later = catchUpWaitState(null, 901000, 901500);
        expect(later.since).to.not.equal(first.since);
        expect(later.since).to.equal('2026-09-08T00:01:00.000Z');
      } finally {
        clock.restore();
      }
    });
  });

  // The sync loop needs a live node below our tip to reach, so the wiring is guarded
  // at source level, the shape nodeCatchUpWait.test.js already uses for this branch.
  describe('the sync loop publishes and clears the wait', function () {
    const detection = trackerSrc.indexOf('The last processed block height are greater than the last block of the node');
    const branchTop = trackerSrc.lastIndexOf('if (lastProcessedBlockIndex > this.blockchainInfoLastBlock)', detection);
    const branch = trackerSrc.slice(branchTop, detection);

    it('populates the field inside the wait branch, threading the previous value', function () {
      expect(branchTop).to.be.greaterThan(0);
      const at = branch.indexOf('nodeStillCatchingUp(lastBlockchainInfo)');
      expect(at).to.be.greaterThan(0);
      const waitBranch = branch.slice(at, branch.indexOf('continue', at));
      expect(waitBranch).to.match(
        /this\.nodeCatchingUp = catchUpWaitState\(this\.nodeCatchingUp,\s*this\.blockchainInfoLastBlock,\s*lastProcessedBlockIndex\)/);
    });

    it('clears the field on the leave-IBD transition', function () {
      const at = branch.indexOf('has left initial block download');
      expect(at).to.be.greaterThan(0);
      expect(branch.slice(at, at + 400)).to.match(/this\.nodeCatchingUp = null/);
    });

    it('clears the field on the other exit, the node tip reaching ours', function () {
      // That exit never enters the branch above, so a wait cleared only there would
      // stay on the health surfaces for the life of the process.
      const before = trackerSrc.slice(Math.max(0, branchTop - 800), branchTop);
      expect(before).to.match(
        /if \(this\.nodeCatchingUp && lastProcessedBlockIndex <= this\.blockchainInfoLastBlock\)\{\s*this\.nodeCatchingUp = null/);
    });
  });

  // api.js builds its payloads inside startApi() against a live tracker, so the two
  // sites are guarded at source level too.
  describe('the api payloads carry node_catching_up', function () {
    it('rides the per-query freshness meta, which both GET /status branches spread', function () {
      const at = apiSrc.indexOf('async function getFreshnessMeta(');
      expect(at).to.be.greaterThan(0);
      const body = apiSrc.slice(at, apiSrc.indexOf('async function setFreshnessHeaders', at));
      expect(body).to.match(/freshness\.node_catching_up = \(tracker && tracker\.nodeCatchingUp\) \|\| null/);

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
      expect(syncBody).to.match(/result\.node_catching_up = \(tracker && tracker\.nodeCatchingUp\) \|\| null/);

      const health = apiSrc.indexOf('async health()');
      const healthBody = apiSrc.slice(health, health + 900);
      expect(healthBody).to.match(/const sync = await jsonRpcController\.get_sync_status\(\)/);
      expect(healthBody).to.match(/\.\.\.sync/);
    });

    it('reads the field through a guard, so a payload built without a tracker cannot throw', function () {
      // Both sites use the same `(tracker && tracker.nodeCatchingUp) || null` form:
      // an absent instance, or one constructed before the field existed, reports null
      // rather than throwing inside a health probe.
      const guards = apiSrc.match(/\(tracker && tracker\.nodeCatchingUp\) \|\| null/g) || [];
      expect(guards).to.have.lengthOf(2);
      const read = (t) => (t && t.nodeCatchingUp) || null;
      expect(read(undefined)).to.equal(null);
      expect(read({})).to.equal(null);
      expect(read(newTracker())).to.equal(null);
    });
  });
});
