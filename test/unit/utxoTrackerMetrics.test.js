/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * The tracker's sync-freshness gauges exist so a wedged or halted tracker is
 * visible WITHOUT the get_sync_status polling rail, so every assertion here
 * drives the real vendored registry and reads the rendered scrape text. A stub
 * registry would pass while the metric never reached a scrape.
 *
 ********************************************************************/

'use strict';

const assert = require('assert');

const { installUtxoTrackerMetrics } = require('../../src/utxoTrackerMetrics.js');
const { installObservability }      = require('../../src/observability');

function realObservability(enabled = true){
    return installObservability(null, {
        service: 'xchain-utxo-tracker',
        env:     enabled ? { METRICS_ENABLED: 'true' } : {}
    });
}

// A tracker at height 812345, committed at a fixed epoch-ms, node one block ahead.
function fakeTracker(overrides = {}){
    return Object.assign({
        lastCommitAt:        1754870400000,
        lastCommittedHeight: 812345,
        latestKnownChainTip: 812346,
        blockchainInfoLastBlock: 812346,
        halted:              false,
        haltReason:          null,
        reorgCount:          0,
        lastReorgDepth:      0,
        isSynced:            () => true
    }, overrides);
}

describe('utxo-tracker sync-freshness metrics', function () {

    it('registers nothing when metrics are off', function () {
        const observability = realObservability(false);
        assert.strictEqual(observability.registry, null,
            'the vendored module leaves the registry null unless METRICS_ENABLED');
        assert.strictEqual(installUtxoTrackerMetrics(observability, fakeTracker()), false);
    });

    it('registers nothing without a tracker', function () {
        assert.strictEqual(installUtxoTrackerMetrics(realObservability(), null), false);
    });

    it('renders the commit heartbeat in epoch SECONDS on the scrape surface', function () {
        const observability = realObservability();
        assert.strictEqual(installUtxoTrackerMetrics(observability, fakeTracker()), true);

        const out = observability.registry.render();
        assert.match(out, /xchain_utxo_tracker_last_commit_timestamp_seconds 1754870400\b/,
            'the gauge must render seconds, not the raw epoch-ms the tracker stores');
        assert.match(out, /xchain_utxo_tracker_committed_height 812345\b/);
        assert.match(out, /xchain_utxo_tracker_node_height 812346\b/);
        assert.match(out, /xchain_utxo_tracker_synced 1\b/);
        assert.match(out, /xchain_utxo_tracker_halted 0\b/);
    });

    it('reads the live tracker at scrape time, so a stalled poll shows a frozen stamp', function () {
        const observability = realObservability();
        const tracker = fakeTracker();
        installUtxoTrackerMetrics(observability, tracker);

        observability.registry.render();
        tracker.lastCommitAt = 1754870460000;
        tracker.lastCommittedHeight = 812346;
        assert.match(observability.registry.render(),
            /xchain_utxo_tracker_last_commit_timestamp_seconds 1754870460\b/,
            'a value captured at registration would freeze at the first scrape');

        // The stall signal IS the frozen value: the tracker stops stamping, the
        // series stops advancing, and time() - <gauge> grows without bound.
        assert.match(observability.registry.render(),
            /xchain_utxo_tracker_last_commit_timestamp_seconds 1754870460\b/);
    });

    it('leaves the commit series absent until the first commit', function () {
        const observability = realObservability();
        installUtxoTrackerMetrics(observability, fakeTracker({
            lastCommitAt: null, lastCommittedHeight: null
        }));
        const out = observability.registry.render();
        // A zero would render as a 1970 timestamp and page an operator on a
        // tracker that is merely still starting up.
        assert.ok(!/xchain_utxo_tracker_last_commit_timestamp_seconds \d/.test(out));
        assert.ok(!/xchain_utxo_tracker_committed_height \d/.test(out));
        // Halt state is knowable from the first scrape, so it is NOT withheld.
        assert.match(out, /xchain_utxo_tracker_halted 0\b/);
    });

    it('publishes the halt state a stopped tracker would otherwise only tell /status', function () {
        const observability = realObservability();
        installUtxoTrackerMetrics(observability, fakeTracker({
            halted: true, haltReason: 'unrecoverable reorg', isSynced: () => false
        }));
        const out = observability.registry.render();
        assert.match(out, /xchain_utxo_tracker_halted 1\b/);
        assert.match(out, /xchain_utxo_tracker_synced 0\b/);
    });

    it('mirrors the lifetime reorg counter without double-counting across scrapes', function () {
        const observability = realObservability();
        const tracker = fakeTracker({ reorgCount: 3, lastReorgDepth: 7 });
        installUtxoTrackerMetrics(observability, tracker);

        observability.registry.render();
        const out = observability.registry.render();
        assert.match(out, /xchain_utxo_tracker_reorgs_total 3\b/,
            'a re-scrape must not add the counter to itself');
        assert.match(out, /xchain_utxo_tracker_last_reorg_depth 7\b/);
    });

    it('survives a tracker whose fields are still null or -1', function () {
        const observability = realObservability();
        installUtxoTrackerMetrics(observability, {
            lastCommitAt: null, lastCommittedHeight: null,
            latestKnownChainTip: null, blockchainInfoLastBlock: -1,
            halted: false, reorgCount: 0, lastReorgDepth: 0
        });
        // render() swallows a throwing collector, so the real assertion is that
        // the metrics that ARE knowable still render.
        const out = observability.registry.render();
        assert.match(out, /xchain_utxo_tracker_halted 0\b/);
        assert.ok(!/xchain_utxo_tracker_node_height /.test(out),
            'a -1 placeholder tip must not render as a real node height');
    });
});
