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

// A node tip below ours outside initial block download: a gap deeper than the
// undo window is refused with the index intact, and a tip that drops below the
// in-memory cursor mid-batch discards the batch and repairs the pointer.

const { expect } = require('chai');
const { buildChain, makeNode, useSyncLoopHarness } = require('./support/harness');

describe('XChainUtxoTracker sync loop: node tip below ours', function () {
    const h = useSyncLoopHarness();

    it('refuses a gap deeper than the undo window without deleting anything, and resumes when the node returns', async function () {
        const node = makeNode(buildChain(40));
        const full = node.chain;
        const seen = await h.run(node, (n, s) => {
            if (n === 1) node.chain = full.slice(0, 2);
            if (n === 2) s.refusedAt = h.tracker.lastCommittedHeight;
            if (n === 3) node.chain = full;
            return n >= 5 ? 'stop' : null;
        });
        expect(seen.refusedAt).to.equal(39);
        expect(h.tracker.reorgCount).to.equal(0);
        expect(seen.height).to.equal(39);
        expect(seen.hash).to.equal(full[39].hash);
    });

    it('discards an open batch and repairs the pointer when the node tip drops below the cursor mid-batch', async function () {
        const node = makeNode(buildChain(40));
        const full = buildChain(70, 0, node.chain, 40);
        const seen = await h.run(node, (n) => {
            if (n === 1) {
                node.chain = full;
                let fired = false;
                node.onBatch = (hs) => {
                    if (!fired && hs[0] >= 60) { fired = true; h.clock += 40000; node.chain = full.slice(0, 45); }
                };
            }
            if (n === 3) node.chain = full;
            return n >= 5 ? 'stop' : null;
        });
        expect(h.tracker.reorgCount).to.equal(0);
        expect(seen.height).to.equal(69);
        expect(seen.hash).to.equal(full[69].hash);
    });
});
