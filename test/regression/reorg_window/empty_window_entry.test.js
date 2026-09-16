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

// Regression: the undo window can come back EMPTY on a restart. A previous
// process spent every slot and the chain still diverges at the stored tip, so
// every restart meets the same store and the same fault within a second.
//
// Without a window to spend, the walk would reach removeFromLastBlocks' generic
// empty-list guard after staging a delete, and that guard cannot say how deep
// the fork is. The depth guard refuses at the FIRST divergence instead, before
// any delete, and states the total depth from the watermark: everything the
// previous process spent plus the one block this pass could not walk back.
//
// Companion to reorg_restart_undo_budget.test.js, which covers the window
// coming back SHORT; this file covers it coming back at zero.

const { expect } = require('chai');
const XChainUtxoTracker = require('../../../src/XChainUtxoTracker');
const {
    createTestTracker,
    closeTracker,
    processBlocksAndCommit,
    buildCoinbaseChain
} = require('../../integration/support/helpers');

// Rebuild the in-memory reorg state from the committed store exactly as start()
// does on boot: only the N records and the watermark survive a restart.
async function simulateRestart(tracker) {
    tracker.lastBlocks = [];
    tracker.pendingKMCleanup = [];
    tracker.undoWindowWatermark = 0;
    tracker.undoWindowWatermarkPersisted = null;
    tracker.lastBlocks = await tracker.loadLastBlocksSortedByHeight();
    await tracker.loadUndoWindowWatermark();
}

// A node whose chain agrees with ours at and below `forkHeight` and disagrees above it.
function nodeForkedAt(blocks, forkHeight) {
    return {
        getBlockHash: async (h) => (h <= forkHeight ? blocks[h].hash : 'ff'.repeat(31) + h.toString(16).padStart(2, '0'))
    };
}

let tracker;

// Twelve committed blocks (0..11) against a six-block window, then a fork at
// height 2 that drains the whole window: the first pass rolls 11..6 back and
// halts with the tip at 5, still diverged.
async function drainWindow() {
    const blocks = buildCoinbaseChain(12, 0, 0);
    await processBlocksAndCommit(tracker, blocks);
    tracker.connector = nodeForkedAt(blocks, 2);
    tracker.lastBlocks = await tracker.loadLastBlocksSortedByHeight();
    await tracker.loadUndoWindowWatermark();
    let first = null;
    try { await tracker.verifyReorg(); } catch (e) { first = e; }
    expect(XChainUtxoTracker.isUnrecoverableReorg(first), 'the first pass exhausts the window').to.equal(true);
    expect(await tracker.db.getLastBlockHeight()).to.equal(5);
    return blocks;
}

function registerTrackerHooks() {
    beforeEach(async function () {
        tracker = await createTestTracker();
        tracker.undoBlocks = 6;
        tracker.sleep = async () => {};
    });
    afterEach(async function () {
        await closeTracker(tracker);
    });
}

describe('Regression: an empty undo window at entry', function () {
    this.timeout(0);
    registerTrackerHooks();

    it('is refused at the first divergence with the fork depth, deleting nothing', async function () {
        const blocks = await drainWindow();

        // The restart inherits an empty window over a tip that still diverges.
        await simulateRestart(tracker);
        expect(tracker.lastBlocks).to.have.length(0);
        expect(tracker.undoWindowWatermark).to.equal(6);

        let err = null;
        try { await tracker.verifyReorg(); } catch (e) { err = e; }

        expect(err, 'an empty window cannot walk back one more block').to.be.an('error');
        expect(XChainUtxoTracker.isUnrecoverableReorg(err)).to.equal(true);
        expect(err.message).to.match(/reorg depth exceeds the recovery window/i);
        expect(err.message).to.not.match(/list is empty/i);
        // The message names what the previous process spent, the nominal window,
        // the height it stopped at, the depth that implies, and the remedy.
        expect(err.message).to.match(/undo window is EMPTY at entry/);
        expect(err.message).to.match(/rolled back all 6 blocks this store held/);
        expect(err.message).to.match(/UNDO_BLOCKS=6/);
        expect(err.message).to.match(/diverges at height 5/);
        expect(err.message).to.match(/at least 7 blocks deep/);
        expect(err.message).to.match(/xchain-node reset xchain-utxo-tracker/);
        // Nothing was deleted: the tip is where the previous pass left it.
        expect(await tracker.db.getLastBlockHeight()).to.equal(5);
        expect(await tracker.db.getLastBlockHash()).to.equal(blocks[5].hash);
    });
});

describe('Regression: an empty undo window at entry', function () {
    this.timeout(0);
    registerTrackerHooks();

    it('says the count is unknown on a store that predates the watermark', async function () {
        await drainWindow();
        await simulateRestart(tracker);
        // A store written before the watermark key existed reads 0.
        tracker.undoWindowWatermark = 0;

        let err = null;
        try { await tracker.verifyReorg(); } catch (e) { err = e; }

        expect(XChainUtxoTracker.isUnrecoverableReorg(err)).to.equal(true);
        expect(err.message).to.match(/undo window is EMPTY at entry/);
        expect(err.message).to.match(/exact count is unknown/);
        expect(err.message).to.match(/deeper than the window/);
        expect(err.message).to.not.match(/at least \d+ blocks deep/);
    });

    it('still returns normally when nothing diverges, for callers that keep no window', async function () {
        const blocks = buildCoinbaseChain(4, 0, 0);
        await processBlocksAndCommit(tracker, blocks);
        tracker.lastBlocks = [];
        tracker.connector = nodeForkedAt(blocks, 3);

        expect(await tracker.verifyReorg()).to.equal(true);
        expect(await tracker.db.getLastBlockHeight()).to.equal(3);
    });
});
