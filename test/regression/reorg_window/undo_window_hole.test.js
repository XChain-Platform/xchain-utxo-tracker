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

// Regression: a hole in the persisted undo window. A block inside the window
// whose N record (and with it its spent-output recovery records) was pruned
// cannot be rolled back: there is nothing to restore. A missing window entry
// is permanent, so the rollback tags it unrecoverable on the first try and the
// tracker halts with its durable marker; a plain error here would be retried
// against the same store and crash-loop every restart.
//
// Companion to empty_window_entry.test.js (the window comes back empty) and
// reorg_restart_undo_budget.test.js (it comes back short but contiguous).

const { expect } = require('chai');
const XChainUtxoTracker = require('../../../src/XChainUtxoTracker');
const {
    createTestTracker,
    closeTracker,
    processBlocksAndCommit,
    buildCoinbaseChain
} = require('../../integration/support/helpers');

// A node whose chain agrees with ours at and below `forkHeight` and disagrees above it.
function nodeForkedAt(blocks, forkHeight) {
    return {
        getBlockHash: async (h) => (h <= forkHeight ? blocks[h].hash : 'ff'.repeat(31) + h.toString(16).padStart(2, '0'))
    };
}

// Drops one block's N record in its own committed batch, as an early prune did.
async function pruneWindowEntry(tracker, hash) {
    await tracker.db.beginTransaction();
    await tracker.db.removeLastStoredBlock(hash);
    await tracker.db.endTransaction();
}

describe('Regression: a hole in the undo window halts instead of crash-looping', function () {
    let tracker;
    let sleeps;

    beforeEach(async function () {
        tracker = await createTestTracker();
        // Twelve committed blocks (0..11) leave a six-block window holding 6..11.
        tracker.undoBlocks = 6;
        sleeps = 0;
        tracker.sleep = async () => { sleeps++; };
    });
    afterEach(async function () {
        await closeTracker(tracker);
    });

    it('tags the rollback unrecoverable on the first attempt when the block is missing from the window', async function () {
        const blocks = buildCoinbaseChain(12, 0, 0);
        await processBlocksAndCommit(tracker, blocks);
        await pruneWindowEntry(tracker, blocks[8].hash);
        tracker.lastBlocks = await tracker.loadLastBlocksSortedByHeight();
        tracker.connector = nodeForkedAt(blocks, 6);

        let err = null;
        try { await tracker.verifyReorg(); } catch (e) { err = e; }

        expect(err, 'the walk must refuse at the hole').to.not.equal(null);
        expect(XChainUtxoTracker.isUnrecoverableReorg(err)).to.equal(true);
        expect(err.message).to.include(blocks[8].hash);
        expect(err.message).to.include('has to be rebuilt');
        expect(sleeps, 'no retries against a permanent fault').to.equal(0);
        // 11..9 rolled back; the refused block and everything below it are intact.
        expect(await tracker.db.getLastBlockHeight()).to.equal(8);
        expect(await tracker.db.getLastBlockHash()).to.equal(blocks[8].hash);
        expect(await tracker.db.getBlock(blocks[8].hash)).to.not.equal(null);
    });

    it('re-reads the window from the store before calling a block missing', async function () {
        const blocks = buildCoinbaseChain(12, 0, 0);
        await processBlocksAndCommit(tracker, blocks);
        tracker.connector = nodeForkedAt(blocks, 8);
        // An in-memory window that lost track of the tip, with the store intact:
        // the rollback must go through, not halt.
        tracker.lastBlocks = blocks.slice(6, 11).map((b) => b.hash);

        await tracker.verifyReorg();

        expect(await tracker.db.getLastBlockHeight()).to.equal(8);
        expect(tracker.lastBlocks).to.deep.equal([blocks[6].hash, blocks[7].hash, blocks[8].hash]);
    });
});
