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

// A node tip below ours while the node is in initial block download is a node
// catching up: the loop publishes the wait and never rolls back during it.

const { expect } = require('chai');
const { buildChain, makeNode, useSyncLoopHarness } = require('./support/harness');

describe('XChainUtxoTracker sync loop: catch-up wait', function () {
    const h = useSyncLoopHarness();

    it('waits on a node in initial block download below our tip, then rolls back once it leaves', async function () {
        const node = makeNode(buildChain(13));
        const seen = await h.run(node, (n, s) => {
            if (n === 1) { node.retired = node.chain; node.chain = node.chain.slice(0, 10); node.ibd = true; }
            if (n === 2) s.waiting = h.tracker.nodeCatchingUp;
            if (n === 3) node.ibd = false;
            return n >= 5 ? 'stop' : null;
        });
        expect(seen.waiting).to.include({ node_height: 9, stored_height: 12 });
        expect(h.tracker.nodeCatchingUp).to.equal(null);
        expect(h.tracker.reorgCount).to.equal(1);
        expect(h.tracker.lastReorgDepth).to.equal(3);
        expect(seen.height).to.equal(9);
    });

    it('clears the catch-up wait when the node tip reaches ours again', async function () {
        const node = makeNode(buildChain(13));
        const full = node.chain;
        const seen = await h.run(node, (n, s) => {
            if (n === 1) { node.chain = full.slice(0, 10); node.ibd = true; }
            if (n === 2) s.waiting = h.tracker.nodeCatchingUp;
            if (n === 3) { node.ibd = false; node.chain = buildChain(15, 0, full, 13); }
            return n >= 5 ? 'stop' : null;
        });
        expect(seen.waiting).to.not.equal(null);
        expect(h.tracker.nodeCatchingUp).to.equal(null);
        expect(h.tracker.reorgCount).to.equal(0);
        expect(seen.height).to.equal(14);
    });
});

// The published wait belongs to the loop run that saw it: a stopped loop is not
// waiting on anything, and a relaunched one has not read the node yet.
describe('XChainUtxoTracker sync loop: catch-up wait across a stop and a relaunch', function () {
    const h = useSyncLoopHarness();

    it('clears the published wait when the loop stops during it', async function () {
        const node = makeNode(buildChain(13));
        const seen = await h.run(node, (n, s) => {
            if (n === 1) { node.chain = node.chain.slice(0, 10); node.ibd = true; }
            if (n >= 2) { s.waiting = h.tracker.nodeCatchingUp; return 'stop'; }
            return null;
        });
        expect(seen.waiting).to.include({ node_height: 9, stored_height: 12 });
        expect(h.tracker.parsingStopped).to.equal(true);
        expect(h.tracker.nodeCatchingUp, 'a stopped loop still publishes a wait').to.equal(null);
    });

    it('starts a relaunched loop with no published wait', async function () {
        const node = makeNode(buildChain(6));
        await h.run(node, (n) => (n >= 2 ? 'stop' : null));
        const tracker = h.tracker;
        // Isolate the per-run reset from the stop-branch one.
        tracker.nodeCatchingUp = { node_height: 3, stored_height: 5, since: 1 };
        node.faults.info = [new Error('node RPC down')];
        let first;
        tracker.sleep = async function () {
            await new Promise((resolve) => setImmediate(resolve));
            if (first === undefined) first = this.nodeCatchingUp;
            this.keepParsing = false;
        };
        await tracker.start();
        expect(first, 'the relaunched loop never slept').to.not.equal(undefined);
        expect(first, 'a relaunched loop publishes the previous run\'s wait').to.equal(null);
    });
});

// Console lines (the harness stubs every console method) that contain `text`.
function linesWith(method, text) {
    return console[method].getCalls().filter((c) => c.args.join(' ').includes(text)).length;
}

// The wait's warn line is latched per event: a wait that ends because the node's
// tip reached ours must drop the latch, or the next event is silent and a later
// real rollback is announced as the end of an initial block download.
describe('XChainUtxoTracker sync loop: catch-up wait log latch', function () {
    const h = useSyncLoopHarness();

    it('logs the wait warn line again for a second wait after the first ended at our tip', async function () {
        const node = makeNode(buildChain(13));
        const full = node.chain;
        await h.run(node, (n) => {
            if (n === 1) { node.chain = full.slice(0, 10); node.ibd = true; }
            if (n === 3) { node.ibd = false; node.chain = buildChain(15, 0, full, 13); }
            if (n === 5) { node.chain = full.slice(0, 10); node.ibd = true; }
            return n >= 7 ? 'stop' : null;
        });
        expect(linesWith('warn', 'initialblockdownload=true'), 'one warn line per wait').to.equal(2);
    });

    it('announces no end of initial block download before a later real rollback', async function () {
        const node = makeNode(buildChain(13));
        const full = node.chain;
        let longer = null;
        await h.run(node, (n) => {
            if (n === 1) { node.chain = full.slice(0, 10); node.ibd = true; }
            if (n === 3) { node.ibd = false; longer = buildChain(15, 0, full, 13); node.chain = longer; }
            if (n === 5) { node.retired = longer; node.chain = longer.slice(0, 12); }
            return n >= 9 ? 'stop' : null;
        });
        expect(h.tracker.reorgCount, 'the later tip drop must roll back').to.equal(1);
        expect(linesWith('log', 'left initial block download')).to.equal(0);
    });
});
