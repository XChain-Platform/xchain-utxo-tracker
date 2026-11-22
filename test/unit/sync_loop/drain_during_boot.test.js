'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const XChainUtxoTracker = require('../../../src/XChainUtxoTracker');
const { buildChain, makeNode, useSyncLoopHarness } = require('./support/harness');

describe('sync-loop shutdown during boot', function () {
    const h = useSyncLoopHarness();

    it('honours a drain requested during the awaited boot prelude', async function () {
        const tracker = new XChainUtxoTracker(
            'bitcoin-regtest', '127.0.0.1', 18443, 'user', 'pass',
            'drain-boot-' + Math.random(), false
        );
        h.tracker = tracker;
        tracker.connector = makeNode(buildChain(1)).connector;
        tracker.updateMempool = async function () {};
        tracker.sleep = async function () { throw new Error('sync pass ran after drain'); };

        const initNativeHistory = tracker.initNativeHistory.bind(tracker);
        tracker.initNativeHistory = async function () {
            await initNativeHistory();
            tracker.stop();
        };

        await tracker.start();

        expect(tracker.drainRequested).to.equal(true);
        expect(tracker.keepParsing).to.equal(false);
        expect(tracker.parsingStopped).to.equal(true);
        expect(tracker.db.db.status).to.equal('closed');
    });
});
