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

// The prev-hash-mismatch rollback discards the open batch. The undo watermark
// staged with it must not outlive the discard: here the in-memory mark is made to
// read deeper than the store, as a staged-then-discarded batch leaves it, and the
// window then refills past it. Q on disk has to follow the refill.

const { expect } = require('chai');
const { Q_UNDO_WATERMARK_KEY } = require('../../../src/XChainUtxoTracker/constants');
const { buildChain, makeNode, useSyncLoopHarness } = require('./support/harness');

describe('XChainUtxoTracker sync loop: undo watermark across a discarded batch', function () {
    const h = useSyncLoopHarness();

    it('rewrites Q to the refilled depth after the prev-hash rollback', async function () {
        const node = makeNode(buildChain(6));
        const seen = await h.run(node, (n) => {
            if (n === 1) {
                h.tracker.undoWindowWatermark = 9;
                h.tracker.undoWindowWatermarkPersisted = 9;
                node.retired = node.chain;
                node.chain = buildChain(9, 7, node.chain, 4);
            }
            return n >= 3 ? 'stop' : null;
        }, {
            inspect: async (s) => {
                s.stored = parseInt((await h.tracker.db.db.get(Q_UNDO_WATERMARK_KEY)).toString(), 10);
            }
        });
        expect(h.tracker.reorgCount).to.equal(1);
        expect(seen.height).to.equal(8);
        expect(h.tracker.undoWindowWatermark).to.equal(9);
        expect(seen.stored).to.equal(9);
    });
});
