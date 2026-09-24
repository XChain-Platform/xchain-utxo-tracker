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

// The synced latch drops whenever the node's tip sits below ours, so the
// xchain_utxo_tracker_synced gauge (which publishes the raw latch) and the
// GET /status verdict (which floors a negative lag) agree on every branch of
// the tip-below-ours path, and the latch rises again once the loop is back at
// the node's tip.

const { expect } = require('chai');
const { buildChain, makeNode, useSyncLoopHarness } = require('./support/harness');
const { installObservability, _resetObservability: resetObservability } = require('../../../src/observability');
const { installUtxoTrackerMetrics } = require('../../../src/server/utxo_tracker_metrics.js');
const XChainUtxoTracker = require('../../../src/XChainUtxoTracker.js');

// Scrapes the real registry and reads the gauge and the /status verdict for
// the same instant; the /status side uses getFreshnessMeta's own inputs.
async function sample(tracker, registry) {
    const tip = (typeof tracker.latestKnownChainTip === 'number')
        ? tracker.latestKnownChainTip : tracker.blockchainInfoLastBlock;
    const committed = await tracker.db.getLastBlockHeight();
    const status = XChainUtxoTracker.computeFreshness(committed, tip, tracker.isSynced());
    return { gauge: Number(gaugeNow(registry)), status: status.synced, lag: status.lag, committed, tip };
}

// Reads the synced series straight off a rendered scrape.
function gaugeNow(registry) {
    return registry.render().match(/^xchain_utxo_tracker_synced (\d+)$/m)[1];
}

// Installs the real metrics on the harness tracker once it exists and resets
// the process-wide registry after each case.
function useMetrics(h) {
    const m = { registry: null };
    m.install = () => {
        const observability = installObservability(null, {
            service: 'xchain-utxo-tracker', env: { METRICS_ENABLED: 'true' }
        });
        installUtxoTrackerMetrics(observability, h.tracker);
        m.registry = observability.registry;
    };
    afterEach(function () { resetObservability(); m.registry = null; });
    return m;
}

describe('XChainUtxoTracker sync loop: synced latch on a refused rollback or a catch-up wait', function () {
    const h = useSyncLoopHarness();
    const metrics = useMetrics(h);
    const install = () => metrics.install();
    const reg = () => metrics.registry;

    it('publishes synced 0 on a refused rollback while the committed tip sits above the node', async function () {
        const node = makeNode(buildChain(40));
        const full = node.chain;
        const seen = await h.run(node, async (n, s) => {
            if (n === 1) { install(); s.atTip = await sample(h.tracker, reg()); node.chain = full.slice(0, 2); }
            if (n === 2) s.refused = await sample(h.tracker, reg());
            if (n === 3) node.chain = full;
            if (n >= 5) { s.back = await sample(h.tracker, reg()); return 'stop'; }
            return null;
        });
        expect(seen.atTip).to.include({ gauge: 1, status: true });
        expect(seen.refused.committed).to.equal(39);
        expect(seen.refused.tip).to.equal(1);
        expect(seen.refused.lag).to.be.below(0);
        expect(seen.refused, 'the gauge must not read synced beside a /status that says not synced')
            .to.include({ gauge: 0, status: false });
        expect(seen.back).to.include({ gauge: 1, status: true });
    });

    it('publishes synced 0 through the catch-up wait, then 1 again once the rollback reaches the tip', async function () {
        const node = makeNode(buildChain(13));
        const seen = await h.run(node, async (n, s) => {
            if (n === 1) { install(); node.retired = node.chain; node.chain = node.chain.slice(0, 10); node.ibd = true; }
            if (n === 2) s.waiting = await sample(h.tracker, reg());
            if (n === 3) node.ibd = false;
            if (n >= 5) { s.back = await sample(h.tracker, reg()); return 'stop'; }
            return null;
        });
        expect(seen.waiting).to.include({ gauge: 0, status: false, committed: 12, tip: 9 });
        expect(h.tracker.reorgCount).to.equal(1);
        expect(seen.back).to.include({ gauge: 1, status: true, committed: 9, tip: 9 });
    });
});

describe('XChainUtxoTracker sync loop: synced latch through a rollback or a node below the parse gate', function () {
    const h = useSyncLoopHarness();
    const metrics = useMetrics(h);
    const install = () => metrics.install();
    const reg = () => metrics.registry;

    it('holds the latch down during the rollback itself and raises it at the node tip', async function () {
        const node = makeNode(buildChain(13));
        const seen = await h.run(node, (n, s) => {
            if (n === 1) {
                install();
                const verifyReorg = h.tracker.verifyReorg;
                h.tracker.verifyReorg = function (...args) {
                    s.duringRollback = gaugeNow(reg());
                    return verifyReorg.apply(this, args);
                };
                node.retired = node.chain;
                node.chain = node.chain.slice(0, 10);
            }
            if (n === 2) s.afterRollback = gaugeNow(reg());
            return n >= 3 ? 'stop' : null;
        });
        expect(h.tracker.reorgCount).to.equal(1);
        expect(seen.height).to.equal(9);
        expect(seen.duringRollback).to.equal('0');
        expect(seen.afterRollback).to.equal('1');
    });

    it('publishes synced 0 when a reindexing node reports its low tip below the parse gate', async function () {
        const node = makeNode(buildChain(8));
        const full = node.chain;
        const seen = await h.run(node, async (n, s) => {
            if (n === 1) { install(); node.chain = full.slice(0, 3); node.ibd = true; node.progress = 0.2; }
            if (n === 2) s.reindexing = await sample(h.tracker, reg());
            if (n === 3) { node.chain = full; node.ibd = false; node.progress = 1; }
            if (n >= 5) { s.back = await sample(h.tracker, reg()); return 'stop'; }
            return null;
        }, { network: 'bitcoin-mainnet' });
        expect(seen.reindexing).to.include({ gauge: 0, status: false, committed: 7, tip: 2 });
        expect(seen.back).to.include({ gauge: 1, status: true, committed: 7, tip: 7 });
    });
});
