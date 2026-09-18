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

// What evidence the loop accepts as "this node's tip is worth parsing", and what
// the GET /status probe then reports. Every case drives the whole path: the loop
// runs past the probe's staleness window, then the probe's own predicate reads
// the stamp the loop did or did not leave.

const { expect } = require('chai');
const { buildChain, makeNode, useSyncLoopHarness } = require('./support/harness');
const { isNodeRpcStale, deriveSyncedVerdict, NODE_RPC_STALE_MS } = require('../../../src/api.js');
const { nodeTipIsParseable } = require('../../../src/XChainUtxoTracker/sync_loop_node_tip.js');
const XChainUtxoTracker = require('../../../src/XChainUtxoTracker.js');

// Measured on a parked BTC regtest rail: the chain sat at height 103 for two
// hours and bitcoind reported this against the 0.99 gate, while the tracker
// beside it still read lag 0 and synced true.
const DECAYED_PROGRESS = 0.9270;

// Runs the loop until the harness clock has advanced past the window GET /status
// judges the last usable tip read against, then returns the probe's verdict.
// `script` may move the node between sleeps, as the other sync-loop cases do.
async function runPastStaleWindow(h, node, network, script) {
    const start = h.clock;
    const seen = await h.run(node, (n, s) => {
        if (script) script(n, s);
        return (h.clock - start) > NODE_RPC_STALE_MS ? 'stop' : null;
    }, { network });
    seen.nodeRpcStale = isNodeRpcStale({ lastNodeRpcOkAt: h.tracker.lastNodeRpcOkAt });
    // The two words GET /status puts on the wire for a reachable store.
    seen.status = seen.nodeRpcStale ? 'stalled' : 'ok';
    return seen;
}

describe('XChainUtxoTracker sync loop: node tip parse gate', function () {
    const h = useSyncLoopHarness();

    it('keeps a parked regtest chain healthy once verificationprogress has decayed', async function () {
        const node = makeNode(buildChain(6));
        const seen = await runPastStaleWindow(h, node, 'bitcoin-regtest', (n) => {
            // Caught up first, exactly as the rail was, then the chain is parked
            // and the node's estimate decays while nothing about it changes.
            if (n >= 2) node.progress = DECAYED_PROGRESS;
        });
        expect(seen.status).to.equal('ok');
        expect(seen.nodeRpcStale).to.equal(false);
        // The contradiction the rail showed: the tracker's own verdict never
        // wavered, so a probe that disagreed with it was reporting the clock.
        expect(h.tracker.synced).to.equal(true);
        expect(seen.height).to.equal(5);
        expect(h.tracker.latestKnownChainTip).to.equal(5);
    });

    it('indexes a block mined onto a parked regtest chain whose progress has decayed', async function () {
        const node = makeNode(buildChain(6));
        const full = buildChain(8, 0, node.chain, 6);
        const seen = await runPastStaleWindow(h, node, 'bitcoin-regtest', (n) => {
            if (n >= 2) node.progress = DECAYED_PROGRESS;
            // Mined well after the decay: a gate that refused the tip would
            // never reach these blocks at all.
            if (n === 40) node.chain = full;
        });
        expect(seen.status).to.equal('ok');
        expect(seen.height).to.equal(7);
    });

    it('still reports a regtest tracker that is genuinely behind its node', async function () {
        // The gate going quiet on regtest must not make the LAG go quiet. Parks
        // the tracker at height 5 behind a node at 405 on block fetches that
        // fail, kept under the desync threshold so the loop keeps retrying.
        const node = makeNode(buildChain(6));
        node.progress = DECAYED_PROGRESS;
        const seen = await h.run(node, (n) => {
            if (n === 1) {
                node.chain = buildChain(406, 0, node.chain, 6);
                node.faults.batch = new Array(15).fill(new Error('node refuses this block'));
            }
            return n >= 10 ? 'stop' : null;
        }, { network: 'bitcoin-regtest' });
        // The loop is reading the tip fine, so the probe is right to say so.
        expect(isNodeRpcStale({ lastNodeRpcOkAt: h.tracker.lastNodeRpcOkAt })).to.equal(false);
        // And the tip it reads is live, which is what makes the lag measurable.
        expect(h.tracker.latestKnownChainTip).to.equal(405);
        expect(seen.height).to.equal(5);
        const lag = h.tracker.latestKnownChainTip - seen.height;
        expect(lag).to.be.greaterThan(XChainUtxoTracker.SYNCED_THRESHOLD);
        expect(deriveSyncedVerdict({ lag })).to.equal(false);
    });
});

// The other half of the matrix: off a mined-on-demand chain the progress
// estimate is real evidence, and nothing here may go quiet.
describe('XChainUtxoTracker sync loop: node tip parse gate off regtest', function () {
    const h = useSyncLoopHarness();

    it('still refuses a genuinely lagging mainnet node', async function () {
        const node = makeNode(buildChain(6));
        node.ibd = true;
        node.progress = 0.20;
        const seen = await runPastStaleWindow(h, node, 'bitcoin-mainnet');
        expect(seen.status).to.equal('stalled');
        expect(seen.nodeRpcStale).to.equal(true);
        expect(seen.height).to.equal(-1);
    });

    it('still refuses a testnet node below the progress gate', async function () {
        // Same number the regtest case above is now healthy on, and off a
        // mined-on-demand chain it means the node really is behind.
        const node = makeNode(buildChain(6));
        node.progress = DECAYED_PROGRESS;
        const seen = await runPastStaleWindow(h, node, 'bitcoin-testnet');
        expect(seen.status).to.equal('stalled');
        expect(seen.nodeRpcStale).to.equal(true);
        expect(seen.height).to.equal(-1);
    });
});

// The edges the loop matrix cannot reach cheaply, read off the policy itself.
describe('nodeTipIsParseable', function () {

    it('reads the progress estimate on every network but regtest', function () {
        const decayed = { verificationprogress: DECAYED_PROGRESS, initialblockdownload: false };
        expect(nodeTipIsParseable(decayed, 'regtest')).to.equal(true);
        for (const net of ['mainnet', 'testnet']) {
            expect(nodeTipIsParseable(decayed, net), net).to.equal(false);
            expect(nodeTipIsParseable({ verificationprogress: 0.99 }, net), net).to.equal(true);
            expect(nodeTipIsParseable({ verificationprogress: 0.98999 }, net), net).to.equal(false);
        }
    });

    it('ignores the progress estimate on regtest however far it has decayed', function () {
        expect(nodeTipIsParseable({ verificationprogress: 0.0001 }, 'regtest')).to.equal(true);
    });

    it('leaves the IBD flag to the tip-below-ours wait on regtest', function () {
        // Reading it HERE would end the pass before reconcileRefreshedTip runs
        // and swallow the catch-up wait, so the gate must not consult it.
        expect(nodeTipIsParseable({ verificationprogress: 1, initialblockdownload: true }, 'regtest')).to.equal(true);
    });

    it('keeps the pre-existing reading of a node that reports no progress field', function () {
        // `undefined < 0.99` was false, so such a node was admitted; an inverted
        // `>= 0.99` would have turned that into a permanent mainnet refusal.
        expect(nodeTipIsParseable({ blocks: 1 }, 'mainnet')).to.equal(true);
        // A regtest node with no IBD field is admitted for the same reason:
        // nodeStillCatchingUp is strict === true.
        expect(nodeTipIsParseable({ blocks: 1 }, 'regtest')).to.equal(true);
    });

    it('refuses a missing reply outright, on every network', function () {
        for (const net of ['mainnet', 'testnet', 'regtest']) {
            expect(nodeTipIsParseable(null, net), net).to.equal(false);
        }
    });

    it('does not treat an unknown network name as regtest', function () {
        // The discriminator is an exact match on the net portion the tracker
        // derives, so nothing else can fall into the mined-on-demand branch.
        const decayed = { verificationprogress: DECAYED_PROGRESS, initialblockdownload: false };
        for (const net of ['Regtest', 'bitcoin-regtest', 'regtest ', '', undefined]) {
            expect(nodeTipIsParseable(decayed, net), String(net)).to.equal(false);
        }
    });
});
