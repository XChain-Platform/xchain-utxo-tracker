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

// A coin node that accepts TCP and never answers must not turn get_sync_status
// into an unbounded queue: per-call node reads through the connector's shared
// socket pool would each hold a slot of the global request gate until it sheds
// plain LevelDB reads. The probe shares one pending node read and gives up on it
// at a deadline, reporting the tip stale.

const { expect } = require('chai');
const sinon = require('sinon');
const { get_sync_status, configureSyncStatusNodeDeadlineMs } = require('../../../src/api/sync_status');

function makeTracker(getBlockchainInfo) {
  return {
    db: { getLastBlockHeight: sinon.stub().resolves(100) },
    connector: { getBlockchainInfo },
    latestKnownChainTip: 100,
    isMempoolReconverged: () => true,
    undoBlocks: 10,
    lastBlocks: []
  };
}

describe('get_sync_status against a hung node', function () {
  let clock;
  beforeEach(function () {
    clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    configureSyncStatusNodeDeadlineMs(5000);
  });
  afterEach(function () {
    clock.restore();
    configureSyncStatusNodeDeadlineMs(5000);
  });

  it('answers every concurrent call by the deadline with one node read, marked stale', async function () {
    const never = sinon.stub().callsFake(() => new Promise(() => {}));
    const tracker = makeTracker(never);

    const calls = Array.from({ length: 200 }, () => get_sync_status(tracker));
    await clock.tickAsync(5001);
    const results = await Promise.all(calls);

    expect(results).to.have.length(200);
    for (const r of results) {
      expect(r.node_height_stale).to.equal(true);
      expect(r.synced).to.equal(false);
    }
    expect(never.callCount).to.be.at.most(1);

    // A later call while the read is still hung joins it rather than queueing another.
    const later = get_sync_status(tracker);
    await clock.tickAsync(5001);
    await later;
    expect(never.callCount).to.be.at.most(1);
  });

  it('returns a fresh node height and a synced verdict when the node answers', async function () {
    const ok = sinon.stub().resolves({ blocks: 101 });
    const tracker = makeTracker(ok);

    const [a, b] = await Promise.all([get_sync_status(tracker), get_sync_status(tracker)]);
    expect(a.node_height).to.equal(101);
    expect(a.node_height_stale).to.equal(undefined);
    expect(a.synced).to.equal(true);
    expect(b.node_height).to.equal(101);
    expect(ok.callCount).to.equal(1);

    // Once settled, the next call reads the node again (no stale cache).
    ok.resolves({ blocks: 105 });
    const c = await get_sync_status(tracker);
    expect(c.node_height).to.equal(105);
    expect(ok.callCount).to.equal(2);
  });
});
