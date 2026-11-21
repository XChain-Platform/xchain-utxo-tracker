/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************/
'use strict'

const XChainUtxoTracker = require('../XChainUtxoTracker')
const {
    configureNodeRpcStaleMs,
    isNodeRpcStale,
    deriveSyncedVerdict,
    NODE_RPC_STALE_MS,
    isValidHeight,
    resolveNodeTip
} = require('../XChainUtxoTracker/catch_up_helpers.js')

// Derives the `health` status word from reachability and halt state only, never
// from lag. Consumers own their own lag budget (xchain-node's bootstrap gate
// allows 100 blocks against the tracker's SYNCED_THRESHOLD of 3), so folding lag
// into `status` would refuse a source the caller would otherwise accept; lag
// travels as its own field for the caller to judge. Halt state DOES reach the
// word: a halted tracker returns 'halted', which sits outside the bootstrap
// gate's accepted set and so refuses the source, matching what the tracker's own
// GET /status already reports and failing closed on a tip we stopped trusting.
// Pure and exported so the policy is unit-testable without a running server.
function deriveHealthStatus({ halted = false, dbOk = false } = {}) {
    if (halted) return 'halted'
    return dbOk ? 'healthy' : 'unhealthy'
}

// Node reachability for the health payloads: `node_last_ok_at` (the last successful
// node RPC, null if there has never been one) and `node_unreachable` (null, or the
// outage with its age in seconds). A tracker whose node never answered a single RPC
// is otherwise indistinguishable from a healthy one on every surface an operator polls;
// these two fields are that difference, reported and never gating.
//
// Fail-soft: an absent connector, or one from a build/test stub predating the method,
// reports the unknown-but-not-failing pair rather than throwing inside a probe.
function nodeReachabilityFields(tracker){
    const connector = tracker && tracker.connector
    if (!connector || typeof connector.nodeReachability !== 'function'){
        return { node_last_ok_at: null, node_unreachable: null }
    }
    try {
        return connector.nodeReachability()
    } catch (e) {
        return { node_last_ok_at: null, node_unreachable: null }
    }
}

// Publish the undo-window high-water mark clamped to undoBlocks, as boot and reorg math read it.
// Returns 0 (unknown) for a missing or unusable mark and never throws, since health() spreads this.
function undoWindowWatermarkField(tracker){
    const mark = tracker ? tracker.undoWindowWatermark : undefined
    if (typeof mark !== 'number' || !Number.isFinite(mark) || mark <= 0) return 0
    const cap = tracker.undoBlocks
    return (typeof cap === 'number' && Number.isFinite(cap)) ? Math.min(mark, cap) : mark
}

// Sync-status probe: tracker tip vs node tip. Used by e2e tests and
// ops tooling to diagnose lag when an address's funding tx looks lost.
// `tracker_height` and `committed_height` are aliases, both report
// the last committed block. `committed_height` is the canonical name
// going forward; `tracker_height` retained for existing callers.
// The tracker's height fields all report the LAST COMMITTED state,
// not in-flight processing. This matters because the tracker buffers
// up to DB_TRANSACTION_BLOCKS_QUANTITY blocks before flushing via
// endTransaction(). During a mid-batch state, in-memory has the new
// UTXOs but disk doesn't; and getLastBlockHeight() reads from disk.
// So getLastBlockHeight() returning N is a hard guarantee that every
// output in blocks 0..N is queryable via get_utxos / get_balance.
// is_quiescent() builds on this: it returns ready=true only when the
// committed height matches the node tip AND the node's mempool is
// empty, giving callers a barrier they can wait on without needing
// to know any of the tracker's batching internals.
//
// The live node read is single-flight per tracker and deadline-bounded. The
// connector's shared 25-socket agent starts its timeout only once a socket is
// assigned, so per-call reads against a node that accepts TCP and never answers
// would queue without bound, each holding a slot of the global request gate until
// the gate sheds pure LevelDB reads. Sharing one pending read caps the queue at one,
// and the deadline lets a caller fall back to the cached tip (reported stale)
// instead of waiting on it.
let SYNC_STATUS_NODE_DEADLINE_MS = 5000

function configureSyncStatusNodeDeadlineMs(value) {
    SYNC_STATUS_NODE_DEADLINE_MS = value
}

const nodeReadInFlight = new WeakMap()

function sharedBlockchainInfo(tracker) {
    let pending = nodeReadInFlight.get(tracker)
    if (!pending) {
        pending = Promise.resolve().then(() => tracker.connector.getBlockchainInfo())
        nodeReadInFlight.set(tracker, pending)
        const clear = () => { if (nodeReadInFlight.get(tracker) === pending) nodeReadInFlight.delete(tracker) }
        pending.then(clear, clear)
    }
    return pending
}

function blockchainInfoWithDeadline(tracker, deadlineMs = SYNC_STATUS_NODE_DEADLINE_MS) {
    let timer
    const deadline = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('node read deadline exceeded')), deadlineMs)
    })
    return Promise.race([sharedBlockchainInfo(tracker), deadline]).finally(() => clearTimeout(timer))
}

async function get_sync_status(tracker) {
    let committedHeight = -1
    try { committedHeight = await tracker.db.getLastBlockHeight() } catch (e) {}
    let committedHash
    try {
        if (typeof tracker.db.getLastBlockHash === 'function') {
            committedHash = await tracker.db.getLastBlockHash()
        }
    } catch (e) {}

    let nodeHeight = -1
    let nodeHeightStale = false
    try {
        const info = await blockchainInfoWithDeadline(tracker)
        if (isValidHeight(info && info['blocks'])) nodeHeight = info['blocks']
        else {
            nodeHeight = resolveNodeTip(tracker)
            nodeHeightStale = true
        }
    } catch (e) {
        nodeHeight = resolveNodeTip(tracker)
        nodeHeightStale = true
    }

    // Also stale when the loop's own tip read aged out: a live answer here cannot vouch for a stuck loop.
    const loopStale = isNodeRpcStale({ lastNodeRpcOkAt: tracker.lastNodeRpcOkAt })
    if (loopStale) nodeHeightStale = true

    const lag = (nodeHeight >= 0 && committedHeight >= 0) ? (nodeHeight - committedHeight) : null
    const result = {
        committed_height: committedHeight,
        tracker_height: committedHeight,
        node_height: nodeHeight,
        lag,
        // Lag and staleness bound the verdict, while the loop latch covers reorg
        // walks and refused tips whose lag alone cannot expose the unsafe view.
        synced: deriveSyncedVerdict({ lag, nodeHeightStale }) && !tracker.halted &&
            typeof tracker.isSynced === 'function' && tracker.isSynced() === true
    }
    // Height and hash commit in one batch. A read crossing that batch can only
    // make a consumer retry; it cannot conceal a tip change spanning its lookup.
    if (typeof committedHash === 'string') result.committed_hash = committedHash
    if (loopStale) {
        result.node_rpc_stale = true
        result.stale_for_ms = Date.now() - tracker.lastNodeRpcOkAt
    }
    return addOperationalStatus(result, tracker, nodeHeightStale)
}

function addOperationalStatus(result, tracker, nodeHeightStale) {
    // Spendability is block sync AND a reconverged mempool, the same pair REST
    // gates X-Mempool-Ready on and get_utxos' freshness sibling now carries.
    // Published here too because this method is the ONLY tracker surface the
    // encoder's serve-readiness probe reads: without the field that probe could
    // not mirror create_tx's UTXO_TRACKER_NOT_READY refusal, and /status painted
    // the encoder healthy for the whole restart window in which create_tx refuses
    // every request (the same kind of divergence the lag field already covers).
    result.mempool_ready = result.synced && tracker.isMempoolReconverged() === true
    if (nodeHeightStale) result.node_height_stale = true
    // Surface mempool RPC health so operators can detect a node that is
    // degraded on mempool fetches without watching the console log.
    if (tracker.mempoolRpcFailures > 0) {
        result.mempool_rpc_failures = tracker.mempoolRpcFailures
        result.last_mempool_error_at = tracker.lastMempoolErrorAt
    }
    // Surface reorg counters so operators can detect chains with
    // frequent reorganizations and know the depth of the last one.
    result.reorg_count = tracker.reorgCount
    result.last_reorg_depth = tracker.lastReorgDepth
    result.pointer_repair_count = tracker.lastBlockPointerRepairCount
    // Non-null ({node_height, stored_height, since}) while the sync loop is
    // waiting out a node in initial block download whose tip is below our
    // committed tip: a deliberate wait, not a stall and not a rollback. Always
    // present (null when not waiting) so `xchain-node ps` can read one shape.
    result.node_catching_up = (tracker && tracker.nodeCatchingUp) || null
    // Whether the coin node is answering this tracker at all, and since when it
    // stopped. node_last_ok_at is null until the first successful RPC, and
    // node_unreachable is non-null ({since, last_ok_at, seconds}) only while the
    // latest attempt has failed. Always present so one shape reads everywhere.
    const reach = nodeReachabilityFields(tracker)
    result.node_last_ok_at = reach.node_last_ok_at
    result.node_unreachable = reach.node_unreachable
    result.undo_window_blocks = tracker.undoBlocks
    // Remaining rollback budget. Every rollback deletes one entry from the
    // persisted undo window and only forward sync puts it back, so a window
    // sitting below undo_window_blocks says a reorg was interrupted (a
    // restart mid-reorg) and names how much depth is left before this index
    // can no longer be walked onto the node's chain. reorg_count and
    // last_reorg_depth are in-memory lifetime counters and read zero after
    // that restart, so they cannot show this on their own.
    result.undo_window_remaining = Array.isArray(tracker.lastBlocks) ? tracker.lastBlocks.length : 0
    // Read spent depth as undo_window_remaining < min(undo_window_watermark, undo_window_blocks);
    // remaining == watermark < blocks is a window refilling after a bootstrap or a raise, and 0 is unknown.
    result.undo_window_watermark = undoWindowWatermarkField(tracker)
    // Surface an unrecoverable block-fetch desync so a monitor can
    // name the fault. Set just before the polling loop fails loud on a node
    // pruned past our cursor; visible in the brief window before exit.
    if (tracker.blockFetchDesync) result.block_fetch_desync = tracker.blockFetchDesync
    addHaltFields(result, tracker)
    return result
}

function addHaltFields(result, tracker) {
    // Halted (unrecoverable reorg): persists, since the tracker no longer
    // exits on this fault but halts in place, so a monitor can alert and an
    // operator can resync. /status also returns 503 while halted. halted_at
    // and halted_height come from the store's marker, so after a restart
    // they still name the FIRST halt, not this process's boot.
    if (tracker.halted) {
        result.halted = true
        result.halt_reason = tracker.haltReason
        result.halted_at = tracker.haltedAt
        result.halted_height = tracker.haltedHeight
    }
}

// The gate-refusal keys the `health` answer carries (addOperationalStatus), for the
// GET /status body. xchain-node's bootstrap gate falls back to /status when its
// `health` POST is shed and refuses on either key, so a body without them passed a
// desynced or node-blind tracker. /status makes no node RPC, so a stale node height
// here is the connector's current outage or the loop's stale tip read; `health` ORs
// the same loop staleness with its own failed live read. Present only when true, as
// on `health`; never throws inside a probe.
function statusRefusalFields(tracker, freshness, nodeRpcStale = false) {
    const fields = {}
    if (tracker && tracker.blockFetchDesync) fields.block_fetch_desync = tracker.blockFetchDesync
    const nodeUnreachable = freshness && freshness.node_unreachable != null
    if (nodeRpcStale === true || nodeUnreachable) fields.node_height_stale = true
    return fields
}

// GET /status: lightweight health probe for Docker HEALTHCHECK and uptime
// monitors. Runs the same DB read that get_sync_status uses to verify the
// store is reachable and returns 503 when it is not. The JSON-RPC catch-all
// would otherwise respond 200 to any GET (serving the method-not-found
// error body), making a DB-down tracker appear healthy to healthchecks.
// Held on the PROBE gate, not the main one: /status is exempt from the main
// cap by `skip`, so its slot lives in probeGate's reserve and only that
// gate's hold() finds it. `isProbe` / `probePath` in installConcurrencyGates
// (src/api/startup.js) must keep matching every request this route answers
// (HEAD, trailing slash, any case), or the admitting gate stops being the
// holding gate and hold() silently no-ops. The hold() rule for every other
// route sits on registerRoutes in src/api/routes.js.
function registerStatusRoute({ app, tracker, probeGate, requestGate, getFreshnessMeta }) {
    app.get('/status', probeGate.hold(async (req, res) => {
        let dbOk = false
        let committedHeight = -1
        try {
            committedHeight = await tracker.db.getLastBlockHeight()
            dbOk = true
        } catch (err) {
            // DB unreachable; fall through to 503
        }
        // Freshness (tracker_height / node_height / lag / synced) rides on BOTH
        // branches from the poll loop's cached tip, no node RPC: xchain-node's
        // BootstrapHealthGate falls back to this probe whenever its `health` POST
        // is shed by the request gate (this route answers from probe_gate's
        // reserve), and a body with no lag field gave that gate's lag refusal
        // nothing to judge. lag stays null when the tip is unknown, never 0.
        const freshness = await getFreshnessMeta(committedHeight)
        // A readable store is not forward progress. The tracking loop retries a
        // failing getBlockchainInfo forever, so a coin node that is down or unsynced
        // freezes block tracking while LevelDB still answers and this probe still
        // said 'ok'. Gate on the loop's own last usable tip read, in
        // memory: no RPC is issued from the probe, so the check adds no node load.
        const nodeRpcStale = isNodeRpcStale({ lastNodeRpcOkAt: tracker.lastNodeRpcOkAt })
        // Same refusal keys as `health`, on both branches (statusRefusalFields above).
        const refusal = statusRefusalFields(tracker, freshness, nodeRpcStale)
        // Halted (unrecoverable reorg): report unhealthy so Docker/monitors see the
        // degradation while the process stays up (no restart thrash; unless-stopped
        // only restarts on exit). Recovery is an operator resync via restorebootstrap.
        if (tracker.halted) {
            res.status(503)
            return res.json({ status: 'halted', halt_reason: tracker.haltReason,
                halted_at: tracker.haltedAt, halted_height: tracker.haltedHeight,
                db: dbOk, committed_height: committedHeight, ...freshness, ...refusal })
        }
        const status = !dbOk ? 'degraded' : (nodeRpcStale ? 'stalled' : 'ok')
        if (!dbOk || nodeRpcStale) res.status(503)
        const body = {
            status, db: dbOk, committed_height: committedHeight, ...freshness, ...refusal,
            // request_gate exposes the global concurrency cap and how many requests
            // it has shed; a climbing shed count is the only outward sign
            // that a distinct-IP stampede is being refused.
            request_gate: requestGate.getStats(), probe_gate: probeGate.getStats()
        }
        if (nodeRpcStale) {
            body.node_rpc_stale = true
            body.stale_for_ms = Date.now() - tracker.lastNodeRpcOkAt
        }
        res.json(body)
    }))
}

module.exports = {
    configureNodeRpcStaleMs,
    configureSyncStatusNodeDeadlineMs,
    deriveHealthStatus,
    isNodeRpcStale,
    deriveSyncedVerdict,
    nodeReachabilityFields,
    undoWindowWatermarkField,
    NODE_RPC_STALE_MS,
    get_sync_status,
    statusRefusalFields,
    registerStatusRoute
}
