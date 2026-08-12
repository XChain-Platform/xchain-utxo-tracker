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

// Regression: tip-pointer / N-window atomicity + restart recovery.
//
// The 2026-05-31 fleet incident: after an unclean restart onto a reorg, the
// persisted tip pointer (setLastBlockHash/Height) and the lastBlocks undo-window
// (the N records) disagreed, so verifyReorg -> removeFromLastBlocks threw
// deterministically and the tracker crash-looped. The durable fix landed
// incrementally (287f010 sort-tip-last, then the 1afdc4f series): the tip pointer
// and the block's N record are now written in ONE atomic db.batch() per block,
// the deferred K/M cleanup is crash-recoverable via the P-key (0x50), and
// loadLastBlocksSortedByHeight rebuilds the window tip-last so a reorg right after
// a restart cannot trip removeFromLastBlocks.
//
// These tests lock that invariant against the committed on-disk state (the level
// the bug lived at): after committing a chain past the undo window, a simulated
// restart (drop all in-memory state, rebuild from the store) must leave the tip
// pointer and the N-window agreeing at the tip, and a tip reorg must not throw -
// including the crash-BEFORE-cleanupAgedBlocks case where aged N records linger.

const { expect } = require('chai');
const {
    SATOSHI,
    createTestTracker,
    closeTracker,
    makeBlock,
    makeCoinbaseTx,
    processBlock,
    processBlocksAndCommit,
    buildCoinbaseChain
} = require('../integration/helpers');

// Single-byte P-key that persists pendingKMCleanup across restarts (mirrors
// P_PENDING_CLEANUP_KEY in XChainUtxoTracker.js; kept local so the test does not
// depend on a module-private export).
const P_PENDING_CLEANUP_KEY = Buffer.from([0x50]);

// Rebuild in-memory state from the committed store exactly as start() does on
// boot: read the tip pointer, reload the N-window tip-last, recover any staged
// K/M cleanup from the P-key. Returns { tipHeight, tipHash }.
async function simulateRestart(tracker) {
    tracker.lastBlocks = [];
    tracker.pendingKMCleanup = [];
    const tipHeight = await tracker.db.getLastBlockHeight();
    const tipHash = await tracker.db.getLastBlockHash();
    tracker.lastBlocks = await tracker.loadLastBlocksSortedByHeight();
    const pVal = await tracker.db.db.get(P_PENDING_CLEANUP_KEY);
    if (pVal !== undefined) tracker.pendingKMCleanup = JSON.parse(pVal.toString());
    return { tipHeight, tipHash };
}

describe('Regression: tip-pointer / N-window atomicity and restart recovery', function () {
    let tracker;

    beforeEach(async function () {
        tracker = await createTestTracker();
        tracker.undoBlocks = 3; // small window so aging/cleanup engages quickly
    });

    afterEach(async function () {
        await closeTracker(tracker);
    });

    it('tip pointer and N-window agree at the tip after a clean restart', async function () {
        const blocks = buildCoinbaseChain(6, 0, 0);
        await processBlocksAndCommit(tracker, blocks);

        const { tipHeight, tipHash } = await simulateRestart(tracker);

        expect(tipHeight).to.equal(5);
        expect(tipHash).to.equal(blocks[5].hash);
        // Window holds exactly undoBlocks entries, ascending height, tip LAST.
        expect(tracker.lastBlocks).to.have.length(3);
        expect(tracker.lastBlocks[tracker.lastBlocks.length - 1]).to.equal(tipHash);
        expect(tracker.lastBlocks).to.deep.equal([blocks[3].hash, blocks[4].hash, blocks[5].hash]);
    });

    it('a tip reorg immediately after restart does not throw (the incident signature)', async function () {
        const blocks = buildCoinbaseChain(6, 0, 0);
        await processBlocksAndCommit(tracker, blocks);
        await simulateRestart(tracker);

        // Roll the tip back one block, exactly as verifyReorg does per block.
        await tracker.db.beginTransaction();
        let threw = null;
        try {
            await tracker.removeFromLastBlocks(blocks[5].hash);
            await tracker.db.setLastBlockHash(blocks[4].hash);
            await tracker.db.setLastBlockHeight(4);
            await tracker.db.endTransaction();
        } catch (e) {
            threw = e;
            try { await tracker.db.endTransaction(false); } catch (_) {}
        }
        expect(threw, threw && threw.message).to.equal(null);

        const { tipHeight, tipHash } = await simulateRestart(tracker);
        expect(tipHeight).to.equal(4);
        expect(tipHash).to.equal(blocks[4].hash);
        expect(tracker.lastBlocks[tracker.lastBlocks.length - 1]).to.equal(blocks[4].hash);
    });

    it('crash before cleanupAgedBlocks leaves no tip/N desync at the tip', async function () {
        // Commit blocks 0..4 in one batch, staging the P-key like the live forward
        // path (XChainUtxoTracker.js ~1511), but SKIP cleanupAgedBlocks to model a
        // crash between endTransaction and the deferred cleanup. Aged N records for
        // blocks 0 and 1 therefore survive on disk (window would otherwise be 2..4).
        const blocks = buildCoinbaseChain(5, 0, 0);
        await tracker.db.beginTransaction();
        for (const b of blocks) await processBlock(tracker, b);
        expect(tracker.pendingKMCleanup).to.deep.equal([blocks[0].hash, blocks[1].hash]);
        await tracker.db.addTransaction('put', P_PENDING_CLEANUP_KEY,
            Buffer.from(JSON.stringify(tracker.pendingKMCleanup)));
        await tracker.db.endTransaction();
        // (no cleanupAgedBlocks - simulated crash)

        const { tipHeight, tipHash } = await simulateRestart(tracker);

        // The tip pointer matches the highest committed block, and the reloaded
        // window - oversized by the un-pruned aged records - is still tip-last, so
        // the tip and the N-window agree exactly where a reorg reads them.
        expect(tipHeight).to.equal(4);
        expect(tipHash).to.equal(blocks[4].hash);
        expect(tracker.lastBlocks[tracker.lastBlocks.length - 1]).to.equal(blocks[4].hash);
        // P-key recovered so the deferred cleanup can still run post-restart.
        expect(tracker.pendingKMCleanup).to.deep.equal([blocks[0].hash, blocks[1].hash]);

        // The reorg that used to crash-loop now succeeds against the recovered state.
        await tracker.db.beginTransaction();
        let threw = null;
        try {
            await tracker.removeFromLastBlocks(blocks[4].hash);
            await tracker.db.endTransaction();
        } catch (e) {
            threw = e;
            try { await tracker.db.endTransaction(false); } catch (_) {}
        }
        expect(threw, threw && threw.message).to.equal(null);
    });

    it('recovered pendingKMCleanup self-heals: aged records prune without deleting the live tip', async function () {
        const blocks = buildCoinbaseChain(5, 0, 0);
        await tracker.db.beginTransaction();
        for (const b of blocks) await processBlock(tracker, b);
        await tracker.db.addTransaction('put', P_PENDING_CLEANUP_KEY,
            Buffer.from(JSON.stringify(tracker.pendingKMCleanup)));
        await tracker.db.endTransaction();

        await simulateRestart(tracker);
        // Run the deferred cleanup that the "crash" skipped. The live-window guard
        // must not delete the N record of any block still in lastBlocks (the tip).
        await tracker.cleanupAgedBlocks();

        const stored = await tracker.loadLastBlocksSortedByHeight();
        expect(stored).to.include(blocks[4].hash, 'tip N record survives cleanup');
        expect(stored[stored.length - 1]).to.equal(blocks[4].hash);
        // Tip pointer still consistent after cleanup.
        expect(await tracker.db.getLastBlockHash()).to.equal(blocks[4].hash);
    });
});
