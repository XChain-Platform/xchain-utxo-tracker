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
            if (n === 3) s.afterRollback = gaugeNow(reg());
            return n >= 4 ? 'stop' : null;
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

// A node that swaps our committed tip at the same height leaves the store serving
// an orphaned block until the walk ends, so the latch must not read synced
// while the tip hash is re-checked or while the walk runs.
describe('XChainUtxoTracker sync loop: synced latch through a same-height tip swap', function () {
    const h = useSyncLoopHarness();
    const metrics = useMetrics(h);
    const install = () => metrics.install();
    const reg = () => metrics.registry;

    // Swaps the node's tip block at the same height and records the latch
    // during the swap's reorg walk.
    function swapTipAtSameHeight(node, full, s) {
        node.retired = full;
        node.chain = buildChain(full.length, 1, full, full.length - 1);
        const verifyReorg = h.tracker.verifyReorg;
        h.tracker.verifyReorg = function (...args) {
            s.duringWalk = { gauge: gaugeNow(reg()), synced: h.tracker.isSynced() };
            return verifyReorg.apply(this, args);
        };
    }

    it('drops the latch for the walk of a same-height tip swap and raises it at the new tip', async function () {
        const node = makeNode(buildChain(13));
        const full = node.chain;
        const seen = await h.run(node, async (n, s) => {
            if (n === 1) { install(); s.atTip = await sample(h.tracker, reg()); swapTipAtSameHeight(node, full, s); }
            if (n >= 4) { s.back = await sample(h.tracker, reg()); return 'stop'; }
            return null;
        });
        expect(seen.atTip).to.include({ gauge: 1, status: true });
        expect(h.tracker.reorgCount).to.equal(1);
        expect(seen.duringWalk, 'the orphaned tip is served under synced').to.deep.equal({ gauge: '0', synced: false });
        expect(seen.back).to.include({ gauge: 1, status: true, committed: 12 });
        expect(seen.hash).to.equal(node.chain[12].hash);
    });

    it('never raises a cleared latch before the same-height hash compare', async function () {
        const node = makeNode(buildChain(13));
        const full = node.chain;
        const seen = await h.run(node, async (n, s) => {
            if (n === 1) {
                install();
                // A latch a tip-below-ours pass just cleared, as at boot.
                h.tracker.synced = false;
                swapTipAtSameHeight(node, full, s);
                const getBlockHash = h.tracker.connector.getBlockHash;
                h.tracker.connector.getBlockHash = async function (height) {
                    if (!('atCompare' in s)) s.atCompare = h.tracker.isSynced();
                    return getBlockHash.call(this, height);
                };
            }
            return n >= 4 ? 'stop' : null;
        });
        expect(seen.atCompare, 'the latch rose before the tip hash was checked').to.equal(false);
        expect(seen.duringWalk).to.deep.equal({ gauge: '0', synced: false });
    });
});

// A node that moves onto a branch one block longer than ours keeps the lag under
// SYNCED_THRESHOLD, so only the prev-hash rollback can drop the latch before the
// walk serves the orphaned tip.
describe('XChainUtxoTracker sync loop: synced latch through a prev-hash reorg', function () {
    const h = useSyncLoopHarness();
    const metrics = useMetrics(h);
    const install = () => metrics.install();
    const reg = () => metrics.registry;

    it('drops the latch for the walk of a prev-hash reorg one block ahead and raises it at the new tip', async function () {
        const node = makeNode(buildChain(13));
        const full = node.chain;
        const seen = await h.run(node, async (n, s) => {
            if (n === 1) {
                install();
                s.atTip = await sample(h.tracker, reg());
                node.retired = full;
                node.chain = buildChain(full.length + 1, 1, full, full.length - 1);
                const verifyReorg = h.tracker.verifyReorg;
                h.tracker.verifyReorg = function (...args) {
                    s.duringWalk = { gauge: gaugeNow(reg()), synced: h.tracker.isSynced() };
                    return verifyReorg.apply(this, args);
                };
            }
            if (n >= 4) { s.back = await sample(h.tracker, reg()); return 'stop'; }
            return null;
        });
        expect(seen.atTip).to.include({ gauge: 1, status: true });
        expect(h.tracker.reorgCount).to.equal(1);
        expect(seen.duringWalk, 'the orphaned tip is served under synced').to.deep.equal({ gauge: '0', synced: false });
        expect(seen.back).to.include({ gauge: 1, status: true, committed: 13 });
        expect(seen.hash).to.equal(node.chain[13].hash);
    });
});

// The latches belong to the loop run that earned them: a stopped loop closes
// its store, and a relaunched one (getbootstrap, restorebootstrap) opens a store
// no pass has checked yet, so neither may report synced or mempool ready.
describe('XChainUtxoTracker sync loop: readiness latches across a stop and a relaunch', function () {
    const h = useSyncLoopHarness();
    const metrics = useMetrics(h);
    const install = () => metrics.install();
    const reg = () => metrics.registry;

    it('drops synced and mempool readiness when the loop stops and closes its store', async function () {
        const node = makeNode(buildChain(6));
        const seen = await h.run(node, async (n, s) => {
            if (n === 1) install();
            if (n >= 2) {
                h.tracker.mempoolReconverged = true;
                s.atTip = await sample(h.tracker, reg());
                return 'stop';
            }
            return null;
        });
        expect(seen.atTip).to.include({ gauge: 1, status: true });
        expect(h.tracker.parsingStopped).to.equal(true);
        expect(h.tracker.isSynced(), 'a closed store is not synced').to.equal(false);
        expect(h.tracker.isMempoolReconverged()).to.equal(false);
        expect(gaugeNow(reg())).to.equal('0');
    });

    it('starts a relaunched loop unsynced until a pass reaches the node tip', async function () {
        const node = makeNode(buildChain(6));
        await h.run(node, (n) => (n >= 2 ? 'stop' : null));
        const tracker = h.tracker;
        // Isolate the per-run reset from the stop-branch one.
        tracker.synced = true;
        tracker.mempoolReconverged = true;
        node.faults.info = [new Error('node RPC down')];
        let first = null;
        tracker.sleep = async function () {
            await new Promise((resolve) => setImmediate(resolve));
            if (first === null) {
                const freshness = XChainUtxoTracker.computeFreshness(
                    await this.db.getLastBlockHeight(), this.blockchainInfoLastBlock, this.isSynced(),
                    { mempoolReconverged: this.isMempoolReconverged() });
                first = { synced: this.isSynced(), mempool: this.isMempoolReconverged(), freshness };
            }
            this.keepParsing = false;
        };
        await tracker.start();
        expect(first, 'the relaunched loop never slept').to.not.equal(null);
        expect(first.synced, 'a relaunched loop must re-earn the latch').to.equal(false);
        expect(first.mempool).to.equal(false);
        expect(first.freshness).to.include({ synced: false, mempool_ready: false });
    });
});
