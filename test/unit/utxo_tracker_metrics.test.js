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

const { installObservability } = require('../../src/observability');
const {
    registerMetricAvailabilityTests,
    registerMetricFreshnessTests,
    registerMetricEdgeTests,
    registerMetricGateTests
} = require('../helpers/utxo_tracker_metric_registration.js');

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

    // The observability registry is process-wide (one process is one service),
    // so a case asserting a series is ABSENT has to start from a clean registry
    // rather than inheriting the previous case's series.
    afterEach(function () { require('../../src/observability')._resetObservability(); });

    const helpers = { realObservability, fakeTracker };
    registerMetricAvailabilityTests(helpers);
    registerMetricFreshnessTests(helpers);
    registerMetricEdgeTests(helpers);
    registerMetricGateTests(helpers);
});
