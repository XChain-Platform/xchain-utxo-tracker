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

// The boot-signal half of ../reorg_restart_undo_budget.test.js, which describes
// the mechanism: boot has to say when the persisted undo window came back short,
// and which of the two causes made it short.

const { expect } = require('chai');
const { captureLog } = require('../../../helpers/capture_log');
const { createTestTracker, closeTracker } = require('../../../integration/support/helpers');

let tracker;
let warnings;
let logs;
let release;

function registerTrackerHooks() {
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
}

function registerLogHooks() {
    // The boot signal goes through the shared logger: warn for a rollback,
    // info for a window that is only still refilling.
    beforeEach(function () {
        warnings = [];
        logs = [];
        release = captureLog(['warn', 'info'], (level, msg) => {
            (level === 'warn' ? warnings : logs).push(msg);
        });
    });
    afterEach(function () {
        release();
    });
}

function registerBootSignalBasicTests() {
    describe('boot signal for a window that came back short', function () {
        registerLogHooks();
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
    });
}

function registerBootSignalRefillTest() {
    describe('boot signal for a window that came back short', function () {
        registerLogHooks();
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
    });
}

function registerBootSignalCauseTests() {
    describe('boot signal for a window that came back short', function () {
        registerLogHooks();
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
}

// The halt that may follow an interrupted reorg lands at a depth far
// shallower than the fork's real one, so boot has to say the window came
// back short or the whole fault reads as arriving out of nowhere.
describe('Regression: the reorg rollback budget survives a restart', function () {
    this.timeout(0);
    registerTrackerHooks();
    registerBootSignalBasicTests();
    registerBootSignalRefillTest();
    registerBootSignalCauseTests();
});
