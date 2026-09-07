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

// Regression: the reorg rollback budget has to come from the PERSISTED undo
// window, not from an in-memory per-call counter.
//
// Measured 2026-09-01 on litecoin testnet: the stored tip was a fork of the
// node's chain, and the tracker halted with
//
//     Can't delete a block from 'last blocks': list is empty
//
// which names no remedy, so the operator's next move (a non-destructive
// recreate) walked straight back into the same wall and only a full rebuild
// cleared it.
//
// Mechanism. Spent-output recovery records (K/M) survive only for the blocks in
// the undo window, and that window IS on disk (the N records). Every rollback
// deletes one N record, so a reorg that is interrupted part-way leaves the
// window SHORT: the surviving window, not `undoBlocks`, is what the tracker can
// still walk back. verifyReorg's depth guard compared its own per-invocation
// `blocksDeleted` counter against the nominal `undoBlocks` instead, and that
// counter restarts at zero with the process. A tracker killed mid-reorg
// therefore believed it had a full budget, spent the short window down to
// nothing, and fell out through removeFromLastBlocks' last-resort empty-list
// throw rather than through the depth guard that names the rebuild remedy.
//
// These tests drive the real store and the real verifyReorg, with a restart
// modelled the way start() rebuilds state: drop the in-memory window and reload
// it from the N records.

const { expect } = require('chai');
const XChainUtxoTracker = require('../../src/XChainUtxoTracker');
const {
    SATOSHI,
    createTestTracker,
    closeTracker,
    makeBlock,
    makeCoinbaseTx,
    processAndCommit,
    processBlocksAndCommit,
    buildCoinbaseChain
} = require('../integration/helpers');

// Rebuild the in-memory reorg state from the committed store exactly as start()
// does on boot. This is the "killed and restarted" step: everything the tracker
// knew in memory is gone, and only the N records are left to reconstruct from.
async function simulateRestart(tracker) {
    tracker.lastBlocks = [];
    tracker.pendingKMCleanup = [];
    tracker.lastBlocks = await tracker.loadLastBlocksSortedByHeight();
}

// A node whose chain agrees with ours at and below `forkHeight` and disagrees
// above it, which is what drives verifyReorg's rollback walk.
function nodeForkedAt(blocks, forkHeight) {
    return {
        getBlockHash: async (h) => (h <= forkHeight ? blocks[h].hash : 'ff'.repeat(31) + h.toString(16).padStart(2, '0'))
    };
}

describe('Regression: the reorg rollback budget survives a restart', function () {
    this.timeout(0);

    let tracker;

    beforeEach(async function () {
        tracker = await createTestTracker();
        // Small window so the arithmetic below stays readable: 12 committed
        // blocks (0..11) leave the window holding 6..11.
        tracker.undoBlocks = 6;
        tracker.sleep = async () => {};
    });

    afterEach(async function () {
        await closeTracker(tracker);
    });

    // Commit heights 0..11 and return the chain.
    async function committedChain() {
        const blocks = buildCoinbaseChain(12, 0, 0);
        await processBlocksAndCommit(tracker, blocks);
        return blocks;
    }

    it('resumes a reorg interrupted part-way and re-syncs while budget remains', async function () {
        const blocks = await committedChain();

        // Reorg one: the node forks at height 8, so 11/10/9 roll back. Model the
        // kill by stopping here, exactly as a SIGKILL between rollbacks would.
        tracker.connector = nodeForkedAt(blocks, 8);
        tracker.lastBlocks = await tracker.loadLastBlocksSortedByHeight();
        await tracker.verifyReorg();

        await simulateRestart(tracker);
        // Three of the six window slots are spent, and that is the state the
        // restarted process has to reason from.
        expect(tracker.lastBlocks).to.deep.equal([blocks[6].hash, blocks[7].hash, blocks[8].hash]);

        // The fork turns out to be one block deeper. Three slots remain, one is
        // needed, so the restarted tracker must simply finish the walk.
        tracker.connector = nodeForkedAt(blocks, 7);
        await tracker.verifyReorg();

        expect(await tracker.db.getLastBlockHeight()).to.equal(7);
        expect(await tracker.db.getLastBlockHash()).to.equal(blocks[7].hash);
        expect(tracker.lastBlocks).to.deep.equal([blocks[6].hash, blocks[7].hash]);
    });

    it('halts with the rebuild remedy, not the bare empty-list error, once the surviving window is spent', async function () {
        const blocks = await committedChain();

        tracker.connector = nodeForkedAt(blocks, 8);
        tracker.lastBlocks = await tracker.loadLastBlocksSortedByHeight();
        await tracker.verifyReorg();

        await simulateRestart(tracker);

        // Now the fork is deeper than the three slots the restart inherited.
        tracker.connector = nodeForkedAt(blocks, 4);

        let err = null;
        try {
            await tracker.verifyReorg();
        } catch (e) {
            err = e;
        }

        expect(err, 'verifyReorg should abort once the surviving window is spent').to.be.an('error');
        expect(XChainUtxoTracker.isUnrecoverableReorg(err)).to.equal(true);
        // The fault the operator has to act on is "this index cannot be walked
        // back onto the node's chain", and the message has to say so and name
        // the rebuild. The bare empty-list throw is the pre-fix signature.
        expect(err.message).to.match(/reorg depth exceeds the recovery window/i);
        expect(err.message).to.not.match(/list is empty/i);
        // It must also account for the rollbacks the previous process already
        // spent, or the depth it reports understates the fork by that much.
        expect(err.message).to.match(/before this restart/i);
    });

    it('gives the next reorg a full budget again once forward sync has refilled the window', async function () {
        const blocks = await committedChain();

        tracker.connector = nodeForkedAt(blocks, 8);
        tracker.lastBlocks = await tracker.loadLastBlocksSortedByHeight();
        await tracker.verifyReorg();

        // Re-sync forward onto the node's chain: three new blocks at 9/10/11
        // refill the three spent slots.
        const rebuilt = [];
        let prevHash = blocks[8].hash;
        for (let h = 9; h <= 11; h++) {
            const block = makeBlock(h, prevHash, [makeCoinbaseTx(0, 10 * SATOSHI)]);
            await processAndCommit(tracker, block);
            rebuilt.push(block);
            prevHash = block.hash;
        }

        await simulateRestart(tracker);
        expect(tracker.lastBlocks).to.have.length(6);

        // A five-deep fork now fits inside the refilled window and must not be
        // refused just because an earlier reorg consumed part of it.
        tracker.connector = {
            getBlockHash: async (h) => (h <= 6 ? blocks[h].hash : 'ff'.repeat(31) + h.toString(16).padStart(2, '0'))
        };
        await tracker.verifyReorg();

        expect(await tracker.db.getLastBlockHeight()).to.equal(6);
        expect(await tracker.db.getLastBlockHash()).to.equal(blocks[6].hash);
    });

    // The halt that may follow an interrupted reorg lands at a depth far
    // shallower than the fork's real one, so boot has to say the window came
    // back short or the whole fault reads as arriving out of nowhere.
    describe('boot signal for a window that came back short', function () {
        let warnings;
        let originalWarn;

        beforeEach(function () {
            warnings = [];
            originalWarn = console.warn;
            console.warn = (msg) => { warnings.push(String(msg)); };
        });

        afterEach(function () {
            console.warn = originalWarn;
        });

        it('names the surviving budget when a rollback was interrupted', function () {
            tracker.lastBlocks = ['a', 'b'];
            const remaining = tracker.noteInterruptedReorgWindow(500);
            expect(remaining).to.equal(2);
            expect(warnings).to.have.length(1);
            expect(warnings[0]).to.match(/undo window came back with 2 of 6/);
            expect(warnings[0]).to.match(/interrupted mid-reorg after rolling back 4/);
        });

        it('stays quiet on a full window', function () {
            tracker.lastBlocks = ['a', 'b', 'c', 'd', 'e', 'f'];
            expect(tracker.noteInterruptedReorgWindow(500)).to.equal(null);
            expect(warnings).to.have.length(0);
        });

        it('stays quiet on a chain shorter than the window, where short is normal', function () {
            tracker.lastBlocks = ['a', 'b'];
            expect(tracker.noteInterruptedReorgWindow(2)).to.equal(null);
            expect(warnings).to.have.length(0);
        });
    });

    // reorg_count and last_reorg_depth are in-memory lifetime counters, so after
    // the restart this item is about they both read zero while a deep reorg is
    // still in flight. The remaining window is the one durable signal that says
    // so, and get_sync_status is where an operator or monitor reads it.
    it('publishes the remaining undo window on get_sync_status', function () {
        const fs = require('fs');
        const path = require('path');
        const src = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');
        const method = src.slice(src.indexOf('async get_sync_status()'));
        expect(method).to.match(/result\.undo_window_blocks\s*=\s*tracker\.undoBlocks/);
        expect(method).to.match(/result\.undo_window_remaining\s*=/);
    });
});
