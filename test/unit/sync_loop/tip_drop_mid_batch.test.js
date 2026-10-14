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

// A node tip reading below the in-memory cursor while a batch is open, with the
// committed tip below that reading. The tip-below branch must settle the
// reading before it discards the batch, and must reload the undo window after
// the discard; a window that still counts the discarded staged blocks ages real
// committed blocks out early and prunes their undo records while they are still
// inside the window, so a later reorg through those heights cannot roll back.
// The discard must also keep the deferred cleanup list, or the blocks on it
// keep their undo records for good.
//
// The chain is bitcoin-regtest, whose undo window is 12 blocks. Every case
// indexes 0..39 first (committed at the tip), then extends the node to 69 and
// acts while the batch stages 40 onwards.

const { expect } = require('chai');
const { buildChain, makeNode, useSyncLoopHarness } = require('./support/harness');

const WINDOW = 12;
// The batch has staged a few blocks past the drop height when this height is
// fetched, fewer than WINDOW, so the stale window still holds committed blocks.
const FIRE_AT_FETCH = 56;
const DROP_TO = 43;

// Extends the node to `full` and, once the open batch fetches FIRE_AT_FETCH,
// runs `act` and moves the clock past the tip refresh interval so the very next
// pass reads the node's tip.
function actMidBatch(h, node, full, act) {
    node.chain = full;
    let fired = false;
    node.onBatch = (hs) => {
        if (fired || hs[0] < FIRE_AT_FETCH) return;
        fired = true;
        h.clock += 40000;
        act();
    };
}

// The next `count` tip readings report `tip` instead of the node's real tip.
function staleTipReadings(node, tip, count) {
    const real = node.connector.getBlockchainInfo;
    let left = count;
    node.connector.getBlockchainInfo = async function () {
        const info = await real.call(this);
        if (left <= 0) return info;
        left--;
        return { ...info, blocks: tip };
    };
}

// Counts batch discards on the tracker the loop is running.
function countDiscards(h, seen) {
    seen.discards = 0;
    const discard = h.tracker.discardInflightBatchForReorg;
    h.tracker.discardInflightBatchForReorg = async function (blocksQuantity) {
        if (blocksQuantity > 0) seen.discards++;
        return discard.call(this, blocksQuantity);
    };
}

// Reads the committed undo window as the loop stops, before it closes the store.
function readWindow(h) {
    return { inspect: async (seen) => { seen.window = await h.tracker.db.getLastStoredBlocks(); } };
}

// The committed undo window must be exactly the node's last WINDOW blocks: no
// hole a reorg could fall into, no aged-out block left behind.
function expectExactWindow(seen, node) {
    const expected = node.chain.slice(-WINDOW).map((b) => b.hash);
    expect(seen.window.slice().sort()).to.deep.equal(expected.slice().sort());
}

// Steps through `phases` in order: each one runs once the committed height
// reaches its `at`, and the loop stops after the last.
function phased(h, phases) {
    let next = 0;
    return (n, seen) => {
        if (n === 1) countDiscards(h, seen);
        const phase = phases[next];
        if (phase && h.tracker.lastCommittedHeight === phase.at) {
            next++;
            if (!phase.run) return 'stop';
            phase.run(seen);
        }
        return null;
    };
}

// Drop, regrow four blocks on a new branch, then reorg ten deep, through
// heights a stale window would prune.
async function dropRegrowShortReorg(h) {
    const node = makeNode(buildChain(40));
    const full = buildChain(70, 0, node.chain, 40);
    const seen = await h.run(node, phased(h, [
        { at: 39, run: () => actMidBatch(h, node, full, () => { node.chain = full.slice(0, DROP_TO + 1); }) },
        { at: DROP_TO, run: () => { node.chain = buildChain(48, 1, node.chain, 44); } },
        { at: 47, run: () => { node.retired = node.chain; node.chain = buildChain(49, 2, node.chain, 38); } },
        { at: 48 },
    ]), readWindow(h));
    expect(h.tracker.halted).to.equal(false);
    expect(h.tracker.lastReorgDepth).to.equal(10);
    expect(seen.hash).to.equal(node.chain[48].hash);
    expectExactWindow(seen, node);
}

// Drop, regrow six blocks, then reorg the whole window.
async function dropRegrowLongerReorgWindow(h) {
    const node = makeNode(buildChain(40));
    const full = buildChain(70, 0, node.chain, 40);
    const seen = await h.run(node, phased(h, [
        { at: 39, run: () => actMidBatch(h, node, full, () => { node.chain = full.slice(0, DROP_TO + 1); }) },
        { at: DROP_TO, run: () => { node.chain = buildChain(50, 1, node.chain, 44); } },
        { at: 49, run: () => { node.retired = node.chain; node.chain = buildChain(51, 2, node.chain, 38); } },
        { at: 50 },
    ]), readWindow(h));
    expect(h.tracker.halted).to.equal(false);
    expect(h.tracker.lastReorgDepth).to.equal(WINDOW);
    expect(seen.hash).to.equal(node.chain[50].hash);
    expectExactWindow(seen, node);
}

// One stale reading mid-batch, catch up to the tip, then a ten-deep reorg.
async function staleReadingThenReorg(h) {
    const node = makeNode(buildChain(40));
    const full = buildChain(70, 0, node.chain, 40);
    const seen = await h.run(node, phased(h, [
        { at: 39, run: () => actMidBatch(h, node, full, () => staleTipReadings(node, DROP_TO, 1)) },
        { at: 69, run: () => { node.retired = node.chain; node.chain = buildChain(71, 2, node.chain, 60); } },
        { at: 70 },
    ]), readWindow(h));
    expect(seen.discards).to.equal(0);
    expect(h.tracker.lastReorgDepth).to.equal(10);
    expect(seen.hash).to.equal(node.chain[70].hash);
    expectExactWindow(seen, node);
}

// One stale reading mid-batch, then catch up to the tip with no reorg.
async function staleReadingNoLeak(h) {
    const node = makeNode(buildChain(40));
    const full = buildChain(70, 0, node.chain, 40);
    const seen = await h.run(node, phased(h, [
        { at: 39, run: () => actMidBatch(h, node, full, () => staleTipReadings(node, DROP_TO, 1)) },
        { at: 69 },
    ]), readWindow(h));
    expect(seen.discards).to.equal(0);
    expect(h.tracker.reorgCount).to.equal(0);
    expectExactWindow(seen, node);
}

// A real drop that the node then undoes: the batch goes, the window does not.
async function realDropThenRestored(h) {
    const node = makeNode(buildChain(40));
    const full = buildChain(70, 0, node.chain, 40);
    const seen = await h.run(node, phased(h, [
        { at: 39, run: () => actMidBatch(h, node, full, () => { node.chain = full.slice(0, DROP_TO + 1); }) },
        { at: DROP_TO, run: () => { node.chain = full; } },
        { at: 69 },
    ]), readWindow(h));
    expect(seen.discards).to.equal(1);
    expect(h.tracker.reorgCount).to.equal(0);
    expect(seen.hash).to.equal(full[69].hash);
    expectExactWindow(seen, node);
}

describe('XChainUtxoTracker sync loop: node tip drops below the cursor mid-batch', function () {
    const h = useSyncLoopHarness();

    it('keeps the undo window whole through a drop, a short regrow and a reorg back past the committed tip',
        () => dropRegrowShortReorg(h));
    it('keeps the undo window whole through a drop, a longer regrow and a reorg of the full window',
        () => dropRegrowLongerReorgWindow(h));
    it('leaves the open batch alone on one stale tip reading, then takes a reorg back past the committed tip',
        () => staleReadingThenReorg(h));
    it('leaks no undo records after one stale tip reading mid-batch', () => staleReadingNoLeak(h));
    it('discards the batch once two readings agree on the drop, and keeps the window whole after',
        () => realDropThenRestored(h));
});
