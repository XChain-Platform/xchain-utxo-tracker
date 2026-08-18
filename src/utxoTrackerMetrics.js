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
 * XChain UTXO Tracker - sync-freshness metrics
 *
 * Tracker-owned Prometheus gauges registered on the observability handle's
 * registry. Lives OUTSIDE src/observability/ because that directory is
 * vendored byte-identically from xchain-hub and its parity check fails on any
 * drift, so a per-service metric may only use the shared module's public API
 * from the service's own code (same reason indexerMetrics.js and
 * decoderMetrics.js sit beside their services).
 *
 * Why the tracker needs its own: commit recency, halt state and reorg counters
 * are reachable only through get_sync_status / GET /status, a single polling
 * rail. If that rail regresses (a misconfigured monitor URL, an auth change, an
 * evaluator bug) a wedged or halted tracker keeps serving frozen UTXO data to
 * the wallet and encoder with no independent stall signal. These gauges make
 * `time() - xchain_utxo_tracker_last_commit_timestamp_seconds` that signal.
 *
 ********************************************************************/

'use strict';

/**
 * Register the tracker's sync-freshness gauges and one scrape-time collector.
 *
 * Everything is read from live in-memory tracker fields inside the collector.
 * The registry renders collectors SYNCHRONOUSLY (Registry#render does not
 * await), so an async read here (tracker.db.getLastBlockHeight()) would resolve
 * after the scrape had already been serialized and silently publish nothing.
 *
 * @param {?{registry: ?object}} observability  installObservability() handle; its registry
 *                                              is null unless METRICS_ENABLED, and a null
 *                                              registry registers nothing.
 * @param {?object} tracker  the live XChainUtxoTracker, read at scrape time.
 * @returns {boolean} true when the metrics were registered.
 */
function installUtxoTrackerMetrics(observability, tracker){
    const registry = observability && observability.registry;
    if(!registry || !tracker) return false;

    const lastCommitTs = registry.gauge({
        name: 'xchain_utxo_tracker_last_commit_timestamp_seconds',
        help: 'Unix time of the most recent forward block commit; stops advancing when the block poll stalls'
    });
    // Paired with node_height on purpose: on a quiet chain a legitimately
    // idle tracker also has an old last-commit time, so the age alone cannot
    // distinguish "no new blocks" from "wedged". Lag is what separates them.
    const committedHeight = registry.gauge({
        name: 'xchain_utxo_tracker_committed_height',
        help: 'Height of the block at the most recent forward commit (a rollback is reflected at the next commit)'
    });
    const nodeHeight = registry.gauge({
        name: 'xchain_utxo_tracker_node_height',
        help: 'Node chain tip height as of the last successful getblockchaininfo poll'
    });
    const synced = registry.gauge({
        name: 'xchain_utxo_tracker_synced',
        help: '1 when the tracker considers itself caught up to the node tip'
    });
    const halted = registry.gauge({
        name: 'xchain_utxo_tracker_halted',
        help: '1 when the tracker has stopped polling on an unrecoverable reorg and needs an operator resync'
    });
    const lastReorgDepth = registry.gauge({
        name: 'xchain_utxo_tracker_last_reorg_depth',
        help: 'Blocks rolled back by the most recent reorg'
    });
    // setMonotonic, not inc: this mirrors a lifetime counter the tracker already
    // keeps, so a re-read must not double-count what the last scrape saw.
    const reorgs = registry.counter({
        name: 'xchain_utxo_tracker_reorgs_total',
        help: 'Reorgs the tracker has rolled back since process start'
    });

    // Gauge#set throws on a non-finite value, and several of these fields are
    // null or -1 before the first poll. A metric simply carries no series until
    // its source has a real value; a zero would render as a 1970 timestamp (or a
    // genesis height) and page an operator on a healthy still-starting tracker.
    const setIf = (gauge, value) => { if(Number.isFinite(value)) gauge.set({}, value); };

    registry.addCollector(() => {
        if(Number.isFinite(tracker.lastCommitAt) && tracker.lastCommitAt > 0)
            lastCommitTs.set({}, tracker.lastCommitAt / 1000);
        setIf(committedHeight, tracker.lastCommittedHeight);

        const tip = Number.isFinite(tracker.latestKnownChainTip)
            ? tracker.latestKnownChainTip
            : tracker.blockchainInfoLastBlock;
        if(Number.isFinite(tip) && tip >= 0) nodeHeight.set({}, tip);

        synced.set({}, (typeof tracker.isSynced === 'function' && tracker.isSynced()) ? 1 : 0);
        halted.set({}, tracker.halted ? 1 : 0);
        setIf(lastReorgDepth, tracker.lastReorgDepth);
        if(Number.isFinite(tracker.reorgCount)) reorgs.setMonotonic({}, tracker.reorgCount);
    });

    return true;
}

module.exports = { installUtxoTrackerMetrics };
