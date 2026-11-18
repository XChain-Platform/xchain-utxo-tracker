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

// The sync loop's two reorg triggers: a next block that does not build on the
// committed tip, and a tip the node swapped at the same height while synced.

const { expect } = require('chai');
const { buildChain, makeNode, useSyncLoopHarness } = require('./support/harness');

describe('XChainUtxoTracker sync loop: reorgs', function () {
    const h = useSyncLoopHarness();

    it('rolls back to the fork point when the next block does not build on the committed tip', async function () {
        const node = makeNode(buildChain(13));
        const seen = await h.run(node, (n) => {
            if (n === 1) { node.retired = node.chain; node.chain = buildChain(16, 7, node.chain, 10); }
            return n >= 3 ? 'stop' : null;
        });
        expect(h.tracker.reorgCount).to.equal(1);
        expect(h.tracker.lastReorgDepth).to.equal(3);
        expect(seen.height).to.equal(15);
        expect(seen.hash).to.equal(node.chain[15].hash);
    });

    it('rolls back a same-height tip swap while synced and indexes the replacement', async function () {
        const node = makeNode(buildChain(13));
        const seen = await h.run(node, (n) => {
            if (n === 1) { node.retired = node.chain; node.chain = buildChain(13, 5, node.chain, 12); }
            return n >= 3 ? 'stop' : null;
        });
        expect(h.tracker.reorgCount).to.equal(1);
        expect(h.tracker.lastReorgDepth).to.equal(1);
        expect(seen.hash).to.equal(node.chain[12].hash);
    });

    it('keeps polling when re-checking the committed tip hash fails', async function () {
        const node = makeNode(buildChain(13));
        const seen = await h.run(node, (n) => {
            if (n === 1) node.faults.hash = [new Error('tip hash unavailable')];
            return n >= 3 ? 'stop' : null;
        });
        expect(seen.height).to.equal(12);
        expect(h.tracker.reorgCount).to.equal(0);
    });
});

describe('XChainUtxoTracker sync loop: reorgs and the synced latch', function () {
    const h = useSyncLoopHarness();

    it('keeps a lowered latch down while re-checking the committed tip hash fails', async function () {
        const node = makeNode(buildChain(13));
        const seen = await h.run(node, (n, s) => {
            if (n === 1) {
                h.tracker.synced = false;
                node.faults.hash = [new Error('tip hash unavailable')];
            }
            if (n === 2) s.afterFailure = h.tracker.isSynced();
            if (n === 3) s.afterCompare = h.tracker.isSynced();
            return n >= 3 ? 'stop' : null;
        });
        expect(seen.afterFailure, 'the latch rose with no hash compare').to.equal(false);
        expect(seen.afterCompare, 'the next compare raises it').to.equal(true);
    });

    it('keeps a raised latch up while re-checking the committed tip hash fails', async function () {
        const node = makeNode(buildChain(13));
        const seen = await h.run(node, (n, s) => {
            if (n === 1) node.faults.hash = [new Error('tip hash unavailable')];
            if (n === 2) s.afterFailure = h.tracker.isSynced();
            return n >= 2 ? 'stop' : null;
        });
        expect(seen.afterFailure).to.equal(true);
    });
});
