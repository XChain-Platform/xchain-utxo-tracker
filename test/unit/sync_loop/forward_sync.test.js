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

// The sync loop's forward path and its boot states: indexing to the node tip,
// the flush triggers, a persisted halt marker and a staged cleanup list.

const { expect } = require('chai');
const sinon = require('sinon');
const { buildChain, makeNode, useSyncLoopHarness } = require('./support/harness');

const P_PENDING_CLEANUP_KEY = Buffer.from([0x50]);

describe('XChainUtxoTracker sync loop: forward sync and boot', function () {
    const h = useSyncLoopHarness();

    it('indexes from genesis to the node tip, starts the mempool poller once and stops cleanly', async function () {
        const node = makeNode(buildChain(13));
        const seen = await h.run(node, (n) => (n >= 2 ? 'stop' : null));
        expect(seen.height).to.equal(12);
        expect(seen.hash).to.equal(node.chain[12].hash);
        expect(h.tracker.lastCommittedHeight).to.equal(12);
        expect(h.tracker.synced).to.equal(true);
        expect(h.tracker.mempoolPolls).to.equal(1);
        expect(h.tracker.mempoolInterval).to.equal(null);
        expect(h.tracker.parsingStopped).to.equal(true);
    });

    it('flushes on heap pressure every block and keeps indexing to the tip', async function () {
        const node = makeNode(buildChain(20));
        sinon.stub(process, 'memoryUsage').returns({ heapUsed: 1e12, rss: 1e9, heapTotal: 0, external: 0, arrayBuffers: 0 });
        const seen = await h.run(node, (n) => (n >= 2 ? 'stop' : null));
        expect(seen.height).to.equal(19);
        expect(h.tracker.lastCommittedHeight).to.equal(19);
    });

    it('boots straight into the halted state from a persisted marker without polling the node', async function () {
        const node = makeNode(buildChain(13));
        h.seedMainStore((store) => store.setHaltMarker({ reason: 'old fault', height: 7, at: 'then' }));
        await h.run(node, () => 'stop');
        expect(h.tracker.halted).to.equal(true);
        expect(h.tracker.haltReason).to.equal('old fault');
        expect(node.infoCalls).to.equal(0);
    });

    it('runs a pending cleanup list a crash left staged and clears its key', async function () {
        const node = makeNode(buildChain(13));
        const staged = [node.chain[1].hash, node.chain[2].hash];
        h.seedMainStore((store) => store.db.put(P_PENDING_CLEANUP_KEY, Buffer.from(JSON.stringify(staged))));
        const seen = await h.run(node, (n) => (n >= 2 ? 'stop' : null), {
            inspect: async (s) => { s.pending = await h.tracker.db.db.get(P_PENDING_CLEANUP_KEY); },
        });
        expect(seen.height).to.equal(12);
        expect(seen.pending).to.equal(undefined);
        expect(h.tracker.pendingKMCleanup).to.deep.equal([]);
    });
});
