'use strict'

const XChainUtxoTracker = require('../XChainUtxoTracker')

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

// Staleness window for the tracker's last usable node-tip read. Five times the
// loop's BLOCKCHAIN_INFO_REFRESH_MS (30s), so a slow or skipped poll never trips
// it and only a sustained outage does.
let NODE_RPC_STALE_MS = 150000

function configureNodeRpcStaleMs(value) {
    NODE_RPC_STALE_MS = value
}

// True when the tracking loop has not read a usable node tip inside the window.
// Deliberately NOT folded into deriveHealthStatus: that helper feeds the `health`
// RPC, whose consumers own their own lag budget, while this gate belongs to the
// GET /status liveness probe alone. An unset timestamp reads not-stale so a
// process whose loop has not started yet is not 503ed before its first poll.
function isNodeRpcStale({ lastNodeRpcOkAt, now = Date.now(), windowMs = NODE_RPC_STALE_MS } = {}) {
    if (typeof lastNodeRpcOkAt !== 'number' || !Number.isFinite(lastNodeRpcOkAt)) return false
    return (now - lastNodeRpcOkAt) > windowMs
}

// The authoritative sync verdict get_sync_status publishes, bounded on BOTH sides.
// A null lag (nothing indexed yet) and a stale node height (RPC down, lag measured
// against a frozen cached tip) are never synced. Neither is a NEGATIVE lag: our
// committed tip sits above the node's, the node-reset/reindex regression
// XChainUtxoTracker rolls back from, so the outputs we would authorize live in
// blocks the node no longer recognizes. The check was upper-bounded only, so
// lag -100 read synced:true and both encoder gates, which delegate this verdict,
// let orphaned UTXOs reach PSBT selection. Pure and exported so the
// bound is unit-testable without a running server.
function deriveSyncedVerdict({ lag, nodeHeightStale = false, threshold = XChainUtxoTracker.SYNCED_THRESHOLD } = {}) {
    if (nodeHeightStale) return false
    if (typeof lag !== 'number' || !Number.isFinite(lag)) return false
    return lag >= 0 && lag <= threshold
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

// Readiness contract: the tracker's height fields all report the LAST
// COMMITTED state, not in-flight processing, since the tracker buffers up
// to DB_TRANSACTION_BLOCKS_QUANTITY blocks before flushing via
// endTransaction() and getLastBlockHeight() reads from disk. So
// getLastBlockHeight() returning N guarantees every output in blocks 0..N
// is queryable via get_utxos / get_balance. is_quiescent() builds on this:
// it returns ready=true only when the committed height matches the node
// tip AND the node's mempool is empty, giving callers a barrier they can
// wait on without needing to know any of the tracker's batching internals.

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

// Authoritative sync verdict computed against the tracker's own
// SYNCED_THRESHOLD so callers don't replicate the threshold. The policy
// (null lag, stale node height and negative lag are all not-synced) lives
// in deriveSyncedVerdict above, where it is unit-testable.

// Spendability is block sync AND a reconverged mempool, the same pair REST
// gates X-Mempool-Ready on and get_utxos' freshness sibling now carries.
// Published here too because this method is the ONLY tracker surface the
// encoder's serve-readiness probe reads: without the field that probe could
// not mirror create_tx's UTXO_TRACKER_NOT_READY refusal, and /status painted
// the encoder healthy for the whole restart window in which create_tx refuses
// every request (the same kind of divergence the lag field already covers).

// Surface mempool RPC health so operators can detect a node that is
// degraded on mempool fetches without watching the console log.

// Surface reorg counters so operators can detect chains with
// frequent reorganizations and know the depth of the last one.

// Non-null ({node_height, stored_height, since}) while the sync loop is
// waiting out a node in initial block download whose tip is below our
// committed tip: a deliberate wait, not a stall and not a rollback. Always
// present (null when not waiting) so `xchain-node ps` can read one shape.

// Whether the coin node is answering this tracker at all, and since when it
// stopped. node_last_ok_at is null until the first successful RPC, and
// node_unreachable is non-null ({since, last_ok_at, seconds}) only while the
// latest attempt has failed. Always present so one shape reads everywhere.

// Remaining rollback budget. Every rollback deletes one entry from the
// persisted undo window and only forward sync puts it back, so a window
// sitting below undo_window_blocks says a reorg was interrupted (a
// restart mid-reorg) and names how much depth is left before this index
// can no longer be walked onto the node's chain. reorg_count and
// last_reorg_depth are in-memory lifetime counters and read zero after
// that restart, so they cannot show this on their own.

// Surface an unrecoverable block-fetch desync so a monitor can
// name the fault. Set just before the polling loop fails loud on a node
// pruned past our cursor; visible in the brief window before exit.

// Halted (unrecoverable reorg): persists, since the tracker no longer
// exits on this fault but halts in place, so a monitor can alert and an
// operator can resync. /status also returns 503 while halted. halted_at
// and halted_height come from the store's marker, so after a restart
// they still name the FIRST halt, not this process's boot.

// Health probe: the richest surface a consumer gates on (lag plus halt
// markers), matching xchain-decoder's and xchain-indexer's health().
// Delegates to get_sync_status so the lag math and SYNCED_THRESHOLD stay
// defined in one place. xchain-node's BootstrapHealthGate probes this
// method first and falls back to GET /status; before that route carried
// freshness, a fallback body had no lag field, the gate's lag refusal
// silently never fired and a badly lagging tracker certified as a
// bootstrap source.

// Sync-status probe: tracker tip vs node tip. Both height fields report the last
// committed state, which guarantees outputs through that height are queryable.
async function get_sync_status(tracker) {
    let committedHeight = -1
    try { committedHeight = await tracker.db.getLastBlockHeight() } catch (e) {}

    let nodeHeight = -1
    let nodeHeightStale = false
    try {
        const info = await tracker.connector.getBlockchainInfo()
        nodeHeight = info['blocks']
    } catch (e) {
        const rawTip = tracker.latestKnownChainTip ?? tracker.blockchainInfoLastBlock
        nodeHeight = (typeof rawTip === 'number') ? rawTip : -1
        nodeHeightStale = true
    }

    const lag = (nodeHeight >= 0 && committedHeight >= 0) ? (nodeHeight - committedHeight) : null
    const result = {
        committed_height: committedHeight,
        tracker_height: committedHeight,
        node_height: nodeHeight,
        lag,
        synced: deriveSyncedVerdict({ lag, nodeHeightStale })
    }
    return addOperationalStatus(result, tracker, nodeHeightStale)
}

function addOperationalStatus(result, tracker, nodeHeightStale) {
    result.mempool_ready = result.synced && tracker.isMempoolReconverged() === true
    if (nodeHeightStale) result.node_height_stale = true
    if (tracker.mempoolRpcFailures > 0) {
        result.mempool_rpc_failures = tracker.mempoolRpcFailures
        result.last_mempool_error_at = tracker.lastMempoolErrorAt
    }
    result.reorg_count = tracker.reorgCount
    result.last_reorg_depth = tracker.lastReorgDepth
    result.node_catching_up = (tracker && tracker.nodeCatchingUp) || null
    const reach = nodeReachabilityFields(tracker)
    result.node_last_ok_at = reach.node_last_ok_at
    result.node_unreachable = reach.node_unreachable
    result.undo_window_blocks = tracker.undoBlocks
    result.undo_window_remaining = Array.isArray(tracker.lastBlocks) ? tracker.lastBlocks.length : 0
    if (tracker.blockFetchDesync) result.block_fetch_desync = tracker.blockFetchDesync
    if (tracker.halted) {
        result.halted = true
        result.halt_reason = tracker.haltReason
        result.halted_at = tracker.haltedAt
        result.halted_height = tracker.haltedHeight
    }
    return result
}

// GET /status: lightweight health probe for Docker HEALTHCHECK and uptime
// monitors. Runs the same DB read that get_sync_status uses to verify the
// store is reachable and returns 503 when it is not. The JSON-RPC catch-all
// would otherwise respond 200 to any GET (serving the method-not-found
// error body), making a DB-down tracker appear healthy to healthchecks.
// Held on the PROBE gate, not the main one: /status is exempt from the main
// cap by `skip`, so its slot lives in probeGate's reserve and only that
// gate's hold() finds it. `isProbe` / PROBE_PATH above must keep matching
// every request this route answers (HEAD, trailing slash, any case), or the
// admitting gate stops being the holding gate and hold() silently no-ops.

// DB unreachable; fall through to 503

// Halted (unrecoverable reorg): report unhealthy so Docker/monitors see the
// degradation while the process stays up (no restart thrash; unless-stopped
// only restarts on exit). Recovery is an operator resync via restorebootstrap.
// Freshness (tracker_height / node_height / lag / synced) rides on BOTH
// branches from the poll loop's cached tip, no node RPC: xchain-node's
// BootstrapHealthGate falls back to this probe whenever its `health` POST
// is shed by the request gate (this route answers from probe_gate's
// reserve), and a body with no lag field gave that gate's lag refusal
// nothing to judge. lag stays null when the tip is unknown, never 0.

// A readable store is not forward progress. The tracking loop retries a
// failing getBlockchainInfo forever, so a coin node that is down or unsynced
// freezes block tracking while LevelDB still answers and this probe still
// said 'ok'. Gate on the loop's own last usable tip read, in
// memory: no RPC is issued from the probe, so the check adds no node load.

// request_gate exposes the global concurrency cap and how many requests
// it has shed; a climbing shed count is the only outward sign
// that a distinct-IP stampede is being refused.

// Lightweight Docker and uptime probe. It uses the cached node tip, so the
// staleness check adds no node RPC load while still detecting lost progress.
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
        const freshness = await getFreshnessMeta(committedHeight)
        if (tracker.halted) {
            res.status(503)
            return res.json({ status: 'halted', halt_reason: tracker.haltReason,
                halted_at: tracker.haltedAt, halted_height: tracker.haltedHeight,
                db: dbOk, committed_height: committedHeight, ...freshness })
        }
        const nodeRpcStale = isNodeRpcStale({ lastNodeRpcOkAt: tracker.lastNodeRpcOkAt })
        const status = !dbOk ? 'degraded' : (nodeRpcStale ? 'stalled' : 'ok')
        if (!dbOk || nodeRpcStale) res.status(503)
        const body = {
            status, db: dbOk, committed_height: committedHeight, ...freshness,
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
    deriveHealthStatus,
    isNodeRpcStale,
    deriveSyncedVerdict,
    nodeReachabilityFields,
    NODE_RPC_STALE_MS,
    get_sync_status,
    registerStatusRoute
}
