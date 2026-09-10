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
 tracker.undoWindowWatermark = 0;
 tracker.undoWindowWatermarkPersisted = null;
    tracker.lastBlocks = await tracker.loadLastBlocksSortedByHeight();
 // start() reads the watermark back before it reports on the window, and the
 // reload is the point of the key: an in-memory-only mark would survive this
 // function and prove nothing.
 await tracker.loadUndoWindowWatermark();
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
 let logs;
        let originalWarn;
 let originalLog;

        beforeEach(function () {
            warnings = [];
 logs = [];
            originalWarn = console.warn;
 originalLog = console.log;
            console.warn = (msg) => { warnings.push(String(msg)); };
 console.log = (msg) => { logs.push(String(msg)); };
        });

        afterEach(function () {
            console.warn = originalWarn;
 console.log = originalLog;
        });

        it('names the surviving budget when a rollback was interrupted', function () {
 // The store had reached the full six-block window before the kill.
 tracker.undoWindowWatermark = 6;
            tracker.lastBlocks = ['a', 'b'];
            const remaining = tracker.noteInterruptedReorgWindow(500);
            expect(remaining).to.equal(2);
            expect(warnings).to.have.length(1);
            expect(warnings[0]).to.match(/undo window came back with 2 of 6/);
            expect(warnings[0]).to.match(/interrupted mid-reorg after rolling back 4/);
        });

        it('stays quiet on a full window', function () {
 tracker.undoWindowWatermark = 6;
            tracker.lastBlocks = ['a', 'b', 'c', 'd', 'e', 'f'];
            expect(tracker.noteInterruptedReorgWindow(500)).to.equal(null);
            expect(warnings).to.have.length(0);
        });

        it('stays quiet on a chain shorter than the window, where short is normal', function () {
 tracker.undoWindowWatermark = 2;
            tracker.lastBlocks = ['a', 'b'];
            expect(tracker.noteInterruptedReorgWindow(2)).to.equal(null);
            expect(warnings).to.have.length(0);
        });

 // The second cause. LTC mainnet booted "48 of 120 blocks, so a
 // previous process was interrupted mid-reorg after rolling back 72" the
 // day after LTC's per-chain window went 48 -> 120 in undo-blocks.js. No
 // 72-block rollback happened, or could have: the window had simply never
 // been deeper than the 48 the old setting allowed.
 it('does not call a window still refilling after a raised UNDO_BLOCKS an interrupted rollback', function () {
 // The store's whole history under the old, shallower setting.
 tracker.undoWindowWatermark = 2;
 // The operator (or a release) raises the window.
 tracker.undoBlocks = 6;
 tracker.lastBlocks = ['a', 'b'];

 const remaining = tracker.noteInterruptedReorgWindow(500);

 expect(remaining).to.equal(2);
 expect(warnings, 'a window filling toward a raised depth is not a fault').to.have.length(0);
 expect(logs.join('\n')).to.match(/came back with 2 of 6/);
 expect(logs.join('\n')).to.match(/Nothing was rolled back/);
 expect(logs.join('\n')).to.match(/never held more than 2/);
 expect(logs.join('\n')).to.not.match(/interrupted/i);
 });

 // Same short window, but the store reached that depth and then lost part
 // of it. That IS the interrupted rollback, and the depth it reports is the
 // shortfall against what the store held, not against the nominal window.
 it('charges the rollback against the depth the store had reached, not the nominal window', function () {
 tracker.undoWindowWatermark = 4;
 tracker.undoBlocks = 6;
 tracker.lastBlocks = ['a', 'b', 'c'];

 expect(tracker.noteInterruptedReorgWindow(500)).to.equal(3);
 expect(warnings).to.have.length(1);
 expect(warnings[0]).to.match(/interrupted mid-reorg after rolling back 1 of the 4/);
 });

 // A store written before the watermark key existed (every tracker already
 // deployed) cannot distinguish the two, and must not assert the reading
 // that was wrong on LTC.
 it('says the two causes are indistinguishable on a store with no watermark yet', function () {
 tracker.undoWindowWatermark = 0;
 tracker.lastBlocks = ['a', 'b'];

 expect(tracker.noteInterruptedReorgWindow(500)).to.equal(2);
 expect(warnings).to.have.length(1);
 expect(warnings[0]).to.match(/cannot be told apart/i);
 expect(warnings[0]).to.match(/raised under an existing store/i);
 expect(warnings[0], 'it must not assert a rollback that may never have happened')
 .to.not.match(/rolling back \d+/);
 });
 });

 // The watermark is only worth anything if it is on disk: the boot that has to
 // tell the two causes apart is a fresh process reading the store it inherited.
 describe('the undo-window watermark is durable', function () {
 it('survives a restart and separates a raise from a rollback on the real store', async function () {
 await committedChain();
 // Twelve committed blocks against a six-block window: the store has
 // held its full window.
 await simulateRestart(tracker);
 expect(tracker.undoWindowWatermark).to.equal(6);

 // Raise the window the way the LTC default was raised. The store is
 // untouched, so the same six N records now read as "6 of 10".
 tracker.undoBlocks = 10;
 await simulateRestart(tracker);
 expect(tracker.lastBlocks).to.have.length(6);
 expect(tracker.undoWindowWatermark).to.equal(6);

 const logs = [];
 const warnings = [];
 const originalLog = console.log;
 const originalWarn = console.warn;
 console.log = (msg) => { logs.push(String(msg)); };
 console.warn = (msg) => { warnings.push(String(msg)); };
 try {
 tracker.noteInterruptedReorgWindow(11);
 } finally {
 console.log = originalLog;
 console.warn = originalWarn;
 }
 expect(warnings).to.have.length(0);
 expect(logs.join('\n')).to.match(/came back with 6 of 10/);

 // Sync one block forward at the new depth: the window grows to 7 and
 // the mark grows with it, so a kill that costs a block is still caught.
 const next = makeBlock(12, (await tracker.db.getLastBlockHash()), [makeCoinbaseTx(0, 10 * SATOSHI)]);
 await processAndCommit(tracker, next);
 await simulateRestart(tracker);
 expect(tracker.undoWindowWatermark).to.equal(7);

 tracker.lastBlocks = tracker.lastBlocks.slice(1);
 const warned = [];
 const prevWarn = console.warn;
 console.warn = (msg) => { warned.push(String(msg)); };
 try {
 tracker.noteInterruptedReorgWindow(12);
 } finally {
 console.warn = prevWarn;
 }
 expect(warned).to.have.length(1);
 expect(warned[0]).to.match(/interrupted mid-reorg after rolling back 1 of the 7/);
 });

 it('clamps a watermark deeper than a LOWERED window instead of reporting the difference as a rollback', async function () {
 await committedChain();
 await simulateRestart(tracker);
 expect(tracker.undoWindowWatermark).to.equal(6);

 // Operator lowers XCHAIN_UNDO_BLOCKS_<COIN>. The window ages down to
 // the new depth; the 6 on disk must not read as a 3-block rollback.
 tracker.undoBlocks = 3;
 await simulateRestart(tracker);
 expect(tracker.undoWindowWatermark).to.equal(3);
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
