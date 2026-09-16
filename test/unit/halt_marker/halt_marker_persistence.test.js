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

// The halt for an unrecoverable reorg has to survive the process. Held only as a
// memory flag, a restart forgets WHY it halted until the rollback throws again
// (within a second, because the persisted undo window is drained), and a
// monitor reading the boot lines sees a fresh start and a fresh fault. The
// marker (the store's R record) is what the next process reads before its sync
// loop starts, so it boots straight into the halted state, keeps the ORIGINAL
// time and height on /status, and never attempts the rollback.

const { expect } = require('chai');
const XChainUtxoTracker = require('../../../src/XChainUtxoTracker');
const LevelUpStore = require('../../../src/store/level_up_db');
const { captureLog } = require('../../helpers/capture_log');
const {
    createTestTracker,
    closeTracker,
    processBlocksAndCommit,
    buildCoinbaseChain
} = require('../../integration/support/helpers');

// A second process on the SAME store: a fresh tracker object that inherits the
// open store and nothing else, the way a restart inherits /data.
function freshInstanceOn(store) {
    const next = new XChainUtxoTracker(
        'bitcoin-regtest', '127.0.0.1', '18443', 'user', 'pass', 'test-db', false
    );
    next.db = store;
    return next;
}

// A node whose chain disagrees with ours above `forkHeight`.
function nodeForkedAt(blocks, forkHeight) {
    return {
        getBlockHash: async (h) => (h <= forkHeight ? blocks[h].hash : 'ff'.repeat(31) + h.toString(16).padStart(2, '0'))
    };
}

// Run resumeHaltFromMarker on `instance` and return its verdict plus the error
// lines it logged, the way a boot log would show them.
async function resumeCapturing(instance) {
    const errors = [];
    const release = captureLog(['error'], (level, msg) => errors.push(msg));
    try {
        const resumed = await instance.resumeHaltFromMarker();
        return { resumed, errors };
    } finally {
        release();
    }
}

let tracker;

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

describe('halt marker: the halt persists in the store', function () {
    this.timeout(0);
    registerTrackerHooks();

    it('haltForResync writes the marker with the reason, the committed height and a time', async function () {
        const blocks = buildCoinbaseChain(5, 0, 0);
        await processBlocksAndCommit(tracker, blocks);

        await tracker.haltForResync('deep reorg on BTC testnet');

        const marker = await tracker.db.getHaltMarker();
        expect(marker).to.be.an('object');
        expect(marker.reason).to.equal('deep reorg on BTC testnet');
        expect(marker.height).to.equal(4);
        expect(marker.at).to.be.a('string');
        expect(Number.isNaN(Date.parse(marker.at)), 'an ISO time').to.equal(false);
        expect(tracker.haltedAt).to.equal(marker.at);
        expect(tracker.haltedHeight).to.equal(4);
    });

    it('a store with no marker boots normally', async function () {
        const { resumed, errors } = await resumeCapturing(tracker);
        expect(resumed).to.equal(false);
        expect(tracker.halted).to.equal(false);
        expect(errors).to.have.length(0);
    });
});

describe('halt marker: a restart on the same store', function () {
    this.timeout(0);
    registerTrackerHooks();

    it('boots halted from the marker, with the original time and height, and says so once', async function () {
        const blocks = buildCoinbaseChain(5, 0, 0);
        await processBlocksAndCommit(tracker, blocks);
        await tracker.haltForResync('deep reorg on BTC testnet');
        const firstAt = tracker.haltedAt;

        const restarted = freshInstanceOn(tracker.db);
        expect(restarted.halted, 'a new object starts clean').to.equal(false);
        const { resumed, errors } = await resumeCapturing(restarted);

        expect(resumed).to.equal(true);
        expect(restarted.halted).to.equal(true);
        expect(restarted.haltReason).to.equal('deep reorg on BTC testnet');
        expect(restarted.haltedAt).to.equal(firstAt);
        expect(restarted.haltedHeight).to.equal(4);
        // The recovery RPCs open with stopParsing, which needs the aborted-loop
        // fact to close the store instead of timing out.
        expect(restarted.parsingAborted).to.equal(true);
        expect(restarted.parsingStopped).to.equal(false);
        expect(errors).to.have.length(1);
        expect(errors[0]).to.equal('[halted] marker from ' + firstAt + ' at height 4: deep reorg on BTC testnet');
    });
});

describe('halt marker: clearing and failing soft', function () {
    this.timeout(0);
    registerTrackerHooks();

    it('clearHalt removes the marker, so the next boot on that store is clean', async function () {
        await tracker.haltForResync('deep reorg');
        expect(await tracker.db.getHaltMarker()).to.be.an('object');

        await tracker.clearHalt();

        expect(tracker.halted).to.equal(false);
        expect(tracker.haltedAt).to.equal(null);
        expect(tracker.haltedHeight).to.equal(null);
        expect(await tracker.db.getHaltMarker()).to.equal(null);
        const restarted = freshInstanceOn(tracker.db);
        expect(await restarted.resumeHaltFromMarker()).to.equal(false);
        expect(restarted.halted).to.equal(false);
    });

    it('the halt holds in memory when the store cannot take the write', async function () {
        const warnings = [];
        const release = captureLog(['warn', 'error'], (level, msg) => { if (level === 'warn') warnings.push(msg); });
        // A closed store rejects the put; the halt must still be declared.
        await tracker.db.close();
        try {
            await tracker.haltForResync('deep reorg');
        } finally {
            release();
        }
        expect(tracker.halted).to.equal(true);
        expect(tracker.haltReason).to.equal('deep reorg');
        expect(warnings.join('\n')).to.match(/could not persist the halt marker/);
    });

    it('a store object without the marker methods (a test stub) halts without throwing', async function () {
        tracker.db = { close: async () => {} };
        await tracker.haltForResync('deep reorg');
        expect(tracker.halted).to.equal(true);
        expect(await tracker.clearHalt()).to.equal(false);
    });

    it('a corrupt marker reads as no marker rather than stopping the boot', async function () {
        await tracker.db.db.put(LevelUpStore.HALT_MARKER_KEY, Buffer.from('not json'));
        expect(await tracker.db.getHaltMarker()).to.equal(null);
        expect(await tracker.resumeHaltFromMarker()).to.equal(false);
    });
});

// End to end from the guard: a fork deeper than the window drains it, the
// depth guard throws the tagged error, the start() guard's halt writes the
// marker at the height the rollback stopped at, and the restart reads it.
describe('halt marker: written by the live halt path at the rolled-back height', function () {
    this.timeout(0);
    registerTrackerHooks();

    it('records the committed height where the walk stopped', async function () {
        const blocks = buildCoinbaseChain(12, 0, 0);
        await processBlocksAndCommit(tracker, blocks);
        tracker.lastBlocks = await tracker.loadLastBlocksSortedByHeight();
        await tracker.loadUndoWindowWatermark();
        // Fork below the six-block window: 11..6 roll back, then the guard fires.
        tracker.connector = nodeForkedAt(blocks, 2);

        let err = null;
        try { await tracker.verifyReorg(); } catch (e) { err = e; }
        expect(XChainUtxoTracker.isUnrecoverableReorg(err)).to.equal(true);

        await tracker.haltForResync(err.message);

        const marker = await tracker.db.getHaltMarker();
        expect(marker.height).to.equal(await tracker.db.getLastBlockHeight());
        expect(marker.height).to.equal(5);
        expect(marker.reason).to.match(/reorg depth exceeds the recovery window/);
    });
});
