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

// A node tip below ours while the node is in initial block download is a node
// catching up: the loop publishes the wait and never rolls back during it.

const { expect } = require('chai');
const { buildChain, makeNode, useSyncLoopHarness } = require('./support/harness');

describe('XChainUtxoTracker sync loop: catch-up wait', function () {
    const h = useSyncLoopHarness();

    it('waits on a node in initial block download below our tip, then rolls back once it leaves', async function () {
        const node = makeNode(buildChain(13));
        const seen = await h.run(node, (n, s) => {
            if (n === 1) { node.retired = node.chain; node.chain = node.chain.slice(0, 10); node.ibd = true; }
            if (n === 2) s.waiting = h.tracker.nodeCatchingUp;
            if (n === 3) node.ibd = false;
            return n >= 5 ? 'stop' : null;
        });
        expect(seen.waiting).to.include({ node_height: 9, stored_height: 12 });
        expect(h.tracker.nodeCatchingUp).to.equal(null);
        expect(h.tracker.reorgCount).to.equal(1);
        expect(h.tracker.lastReorgDepth).to.equal(3);
        expect(seen.height).to.equal(9);
    });

    it('clears the catch-up wait when the node tip reaches ours again', async function () {
        const node = makeNode(buildChain(13));
        const full = node.chain;
        const seen = await h.run(node, (n, s) => {
            if (n === 1) { node.chain = full.slice(0, 10); node.ibd = true; }
            if (n === 2) s.waiting = h.tracker.nodeCatchingUp;
            if (n === 3) { node.ibd = false; node.chain = buildChain(15, 0, full, 13); }
            return n >= 5 ? 'stop' : null;
        });
        expect(seen.waiting).to.not.equal(null);
        expect(h.tracker.nodeCatchingUp).to.equal(null);
        expect(h.tracker.reorgCount).to.equal(0);
        expect(seen.height).to.equal(14);
    });
});
