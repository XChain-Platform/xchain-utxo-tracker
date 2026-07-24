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
const XChainUtxoTracker = require('../../src/XChainUtxoTracker');
const { handleBootstrapFailure, handleRestoreFailure } = require('../../src/bootstrap-recovery');

// ─── Regression (M-11): per-query freshness surface ──────────────────────────
//
// UTXO/balance results are served from the last COMMITTED height, which can lag
// the node tip during catch-up or a reorg. Callers (e.g. the encoder selecting
// inputs) previously had no freshness signal on the response itself. The API now
// exposes committed height / node tip / lag / synced, computed by the shared
// XChainUtxoTracker.computeFreshness so the contract can't drift.
describe('Regression (M-11): computeFreshness', function () {

  it('computes lag as node tip minus committed height', function () {
    const f = XChainUtxoTracker.computeFreshness(100, 105, false);
    expect(f).to.deep.equal({ tracker_height: 100, node_height: 105, lag: 5, synced: false });
  });

  it('reports lag 0 when caught up, carrying the synced verdict through', function () {
    const f = XChainUtxoTracker.computeFreshness(200, 200, true);
    expect(f).to.deep.equal({ tracker_height: 200, node_height: 200, lag: 0, synced: true });
  });

  it('returns null lag (not 0) when nothing is indexed yet', function () {
    // committedHeight -1 means the tracker has indexed nothing; lag is unknown.
    const f = XChainUtxoTracker.computeFreshness(-1, 500, false);
    expect(f.lag).to.equal(null);
    expect(f.synced).to.equal(false);
  });

  it('returns null lag when the node tip is unknown', function () {
    const f = XChainUtxoTracker.computeFreshness(300, -1, false);
    expect(f.lag).to.equal(null);
  });

  it('coerces non-numeric inputs to the -1 sentinel and a boolean synced', function () {
    const f = XChainUtxoTracker.computeFreshness(undefined, null, 'yes');
    expect(f.tracker_height).to.equal(-1);
    expect(f.node_height).to.equal(-1);
    expect(f.lag).to.equal(null);
    // synced must be a strict boolean, never a truthy string leaking through.
    expect(f.synced).to.equal(false);
  });
});

// ─── Regression (M-9): bootstrap/restore recovery must not freeze or strand ───
//
// A failed bootstrap compression previously froze the tracker (parsing stopped,
// never relaunched) and a failed restore stranded a wiped /data, both without a
// surfaced error. Bootstrap failure now resumes indexing and keeps the task
// record; restore failure (which wipes /data before extracting) fails loud so a
// supervisor restarts into a clean recovery path.
describe('Regression (M-9): bootstrap/restore recovery handlers', function () {

  it('bootstrap failure resumes indexing and preserves a surfaced error on the task', function () {
    const tasks = { t1: { progress: 40, filename: 'snap.tar.gz' } };
    let relaunched = 0;
    handleBootstrapFailure({
      tasks, taskId: 't1', error: new Error('pigz died'),
      relaunch: () => { relaunched++; },
      log: () => {}
    });
    expect(relaunched, 'must relaunch the tracker so it does not freeze').to.equal(1);
    // Task is KEPT (not deleted) with progress -1 and the error, so a status poll
    // surfaces the failure instead of a bare "taskid doesn't exist".
    expect(tasks.t1.progress).to.equal(-1);
    expect(tasks.t1.error).to.equal('pigz died');
  });

  it('restore failure fails loud (does not silently resume) and records the error', function () {
    const tasks = { t2: { progress: 70, filename: 'snap.tar.gz' } };
    let failedLoud = 0;
    let relaunched = 0;
    handleRestoreFailure({
      tasks, taskId: 't2', error: new Error('tar truncated'),
      failLoud: () => { failedLoud++; },
      // No relaunch is passed: the handler must not resume indexing on a wiped DB.
      log: () => {}
    });
    expect(failedLoud, 'must fail loud for a supervised restart').to.equal(1);
    expect(relaunched).to.equal(0);
    expect(tasks.t2.progress).to.equal(-1);
    expect(tasks.t2.error).to.equal('tar truncated');
  });

  // #3192: a pre-wipe validation abort (error.preWipe) happens BEFORE /data is
  // touched, so the DB is intact and indexing can resume. It must NOT fail loud
  // (which would kill the process with a factually wrong "AFTER /data was wiped"
  // message) - it resumes via relaunch, exactly like a bootstrap failure.
  it('restore PRE-wipe validation abort resumes indexing and does not fail loud', function () {
    const tasks = { t3: { progress: 0, filename: 'snap.tar.gz' } };
    let failedLoud = 0;
    let relaunched = 0;
    const err = new Error('Refusing to restore: no checksum sidecar');
    err.preWipe = true;
    handleRestoreFailure({
      tasks, taskId: 't3', error: err,
      failLoud: () => { failedLoud++; },
      relaunch: () => { relaunched++; },
      log: () => {}
    });
    expect(failedLoud, 'a DB-intact pre-wipe abort must NOT exit the process').to.equal(0);
    expect(relaunched, 'must resume indexing since /data was never wiped').to.equal(1);
    expect(tasks.t3.progress).to.equal(-1);
    expect(tasks.t3.error).to.equal('Refusing to restore: no checksum sidecar');
  });
});
