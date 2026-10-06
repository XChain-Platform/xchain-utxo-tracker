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

// Regression: an EMPTY undo window at entry with the committed tip ABOVE the
// node's tip. Every gap size gets one classification: it parks before any
// delete, with a message that says the window is empty and claims no intact index.
//
// Height alone does not prove divergence (the node may be catching up onto our
// tip). Once the node reaches our height the hash compare decides: a match
// resumes, a mismatch takes the depth guard's unrecoverable halt.
//
// Companion to empty_window_entry.test.js, which drives the hash-compare path.

const { expect } = require('chai');
const XChainUtxoTracker = require('../../../src/XChainUtxoTracker');
const {
    createTestTracker,
    closeTracker,
    processBlocksAndCommit,
    buildCoinbaseChain
} = require('../../integration/support/helpers');

const TIP = 19;

// A node whose chain agrees with ours at and below `forkHeight` and disagrees above it.
function nodeForkedAt(blocks, forkHeight) {
    return {
        getBlockHash: async (h) => (h <= forkHeight ? blocks[h].hash : 'ff'.repeat(31) + h.toString(16).padStart(2, '0'))
    };
}

let tracker, blocks;

function registerTrackerHooks() {
    beforeEach(async function () {
        tracker = await createTestTracker();
        tracker.undoBlocks = 6;
        tracker.sleep = async () => {};
        blocks = buildCoinbaseChain(TIP + 1, 0, 0);
        await processBlocksAndCommit(tracker, blocks);
        // The persisted window is empty at entry, as after a drained reorg.
        tracker.lastBlocks = [];
        tracker.connector = nodeForkedAt(blocks, TIP);
    });
    afterEach(async function () {
        await closeTracker(tracker);
    });
}

async function expectParkedWithNothingDeleted(nodeTip) {
    let err = null;
    try { await tracker.verifyReorg(nodeTip); } catch (e) { err = e; }
    expect(err, 'gap ' + (TIP - nodeTip) + ' must refuse').to.be.an('error');
    expect(err.tipBelowCommittedTip).to.equal(true);
    expect(XChainUtxoTracker.isUnrecoverableReorg(err)).to.equal(false);
    expect(err.message).to.match(/undo window is EMPTY/);
    expect(err.message).to.match(/0 of UNDO_BLOCKS=6 available/);
    expect(err.message).to.not.match(/no rebuild is needed/);
    expect(err.message).to.not.match(/index is intact/);
    expect(await tracker.db.getLastBlockHeight()).to.equal(TIP);
    expect(await tracker.db.getLastBlockHash()).to.equal(blocks[TIP].hash);
}

describe('Regression: an empty undo window with the committed tip above the node', function () {
    this.timeout(0);
    registerTrackerHooks();

    it('parks a gap wider than UNDO_BLOCKS without claiming a window', async function () {
        await expectParkedWithNothingDeleted(TIP - 8);
    });

    it('parks a one-block gap the same way (it used to halt for a rebuild)', async function () {
        await expectParkedWithNothingDeleted(TIP - 1);
    });

    it('parks a gap of exactly UNDO_BLOCKS the same way', async function () {
        await expectParkedWithNothingDeleted(TIP - 6);
    });
});

describe('Regression: an empty undo window once the node reaches the committed tip', function () {
    this.timeout(0);
    registerTrackerHooks();

    it('resumes when the node caught up onto this chain', async function () {
        expect(await tracker.verifyReorg(TIP)).to.equal(true);
        expect(await tracker.db.getLastBlockHeight()).to.equal(TIP);
    });

    it('halts as unrecoverable when the node caught up onto a fork', async function () {
        tracker.connector = nodeForkedAt(blocks, TIP - 3);
        let err = null;
        try { await tracker.verifyReorg(TIP); } catch (e) { err = e; }
        expect(XChainUtxoTracker.isUnrecoverableReorg(err)).to.equal(true);
        expect(err.message).to.match(/undo window is EMPTY at entry/);
        expect(await tracker.db.getLastBlockHeight()).to.equal(TIP);
    });
});
