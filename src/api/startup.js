'use strict'

const express = require('express')
const bodyParser = require('body-parser')
const helmet = require('helmet')
const cors = require('cors')
const rateLimit = require('express-rate-limit')
const XChainUtxoTracker = require('../XChainUtxoTracker')
const { installObservability, getLogger } = require('../observability')
const { installUtxoTrackerMetrics } = require('../server/utxo_tracker_metrics')
const { createShutdown, createTrackerDrain } = require('../server/shutdown.js')
const concurrencyGate = require('../server/concurrency_gate.js')
const { parseCorsOrigin } = require('../server/cors_origin.js')
const memoryBudget = require('../store/memory_budget')
const { nodeReachabilityFields } = require('./sync_status.js')
const { registerRoutes } = require('./routes.js')
const logger = getLogger()

//Start the tracker

// Parse optional ?limit=&after= pagination params into tracker opts. Throws a
// BAD_REQUEST-coded error on a malformed limit so the route returns HTTP 400.

// Map address-query errors to HTTP status codes. ADDRESS_TOO_LARGE -> 413 (use
// pagination); malformed cursor/limit -> 400; everything else -> 500. Without
// this, an unbounded mega-address query would have OOM-crashed the process.

// Return balance

// Per-query freshness surface. UTXO/balance results are
// served from the last COMMITTED height, which can lag the node tip during
// catch-up or a reorg, so a caller (e.g. the encoder selecting inputs) can
// otherwise pick a UTXO from a view that is already stale without any signal
// on the response itself. Report the committed height, the cached node tip,
// the lag between them, and the synced verdict so callers can gate.
// Derived from a single LevelDB read plus the node tip the poll loop already
// caches, so it adds no per-query RPC. lag is null when nothing is indexed
// yet or the node tip is not yet known; callers must treat null as "unknown,
// do not assume fresh", never as lag 0.
// Also carries mempool_ready (block sync AND mempool reconvergence, the same
// pair REST gates X-Mempool-Ready on) and, while halted, the halt marker, so
// an RPC caller gates on the same facts a REST caller can. A caller that has
// already read the committed height (GET /status) passes it in to skip the
// second LevelDB read.

// Non-null ({node_height, stored_height, since}) while the sync loop is waiting
// out a node in initial block download whose tip is below our committed tip:
// the tracker is deliberately not advancing and is not stalled. Read through a
// guard so a probe answered before the tracker exists still returns a payload.

// Whether the coin node is answering this tracker at all, and since when it
// stopped. Reported, never gated on, for the reason node_height_stale is: a
// restart cannot fix an upstream outage. A tracker whose node has NEVER answered
// is otherwise indistinguishable here from a healthy one.

// The lifetime rollback counter, the same field get_sync_status publishes.
// It is here because every get_utxos PAGE carries this object as its `sync`
// sibling, and a paginating consumer compares consecutive pages to prove
// they describe one snapshot. Height alone cannot: a rewind that re-applies
// to the SAME height leaves tracker_height, lag and synced identical on both
// pages while an early page's outpoint is already orphaned, so the consumer's
// counter comparison (xchain-encoder/src/build/utxo_tracker.js snapshotDivergence)
// was written against a field the producer never sent and could never fire.
// Published as a number so a page that omits it still reads as an older
// tracker rather than as a moved counter.

// Stamp the freshness fields onto a REST response as headers, leaving the
// existing body shape untouched (additive, backward-compatible). X-Sync-Lag
// is omitted entirely when lag is unknown (null) rather than sent as a
// misleading 0.

// Create the app

// Ahead of every middleware below; rationale at installUnmatchedRouteLabel.

async function getUtxos(tracker, address, opts){
    return await tracker.getUtxosAddress(address, opts)
}

async function getFirstSeen(tracker, address){
    return await tracker.getFirstSeen(address)
}

async function getBalance(tracker, address){
    let utxos = await tracker.getUtxosAddress(address)
    let balance = 0n
    for (let nextUtxo of utxos) balance = balance + BigInt(nextUtxo.value)
    return XChainUtxoTracker.satoshiToDecimalString(balance)
}

async function getInfo(tracker, address){
    return await tracker.getBalanceInfo(address)
}

// Parse optional pagination params. A malformed limit is a 400 error.
function parsePageOpts(query, maxPageLimit){
    const opts = {}
    if (query && query.limit != null && query.limit !== '') {
        const n = Number(query.limit)
        if (!Number.isInteger(n) || n <= 0) {
            const e = new Error('limit must be a positive integer')
            e.code = 'BAD_REQUEST'
            throw e
        }
        opts.limit = Math.min(n, maxPageLimit)
    }
    if (query && query.after != null && query.after !== '') opts.after = String(query.after)
    return opts
}

// Per-query freshness uses one LevelDB read plus the cached node tip and adds
// no per-query RPC. A known height lets GET /status skip the second DB read.
async function getFreshnessMeta(tracker, knownCommittedHeight){
    let committedHeight = -1
    if (typeof knownCommittedHeight === 'number') committedHeight = knownCommittedHeight
    else { try { committedHeight = await tracker.db.getLastBlockHeight() } catch (e) {} }
    const rawTip = (typeof tracker.latestKnownChainTip === 'number')
        ? tracker.latestKnownChainTip
        : (typeof tracker.blockchainInfoLastBlock === 'number' ? tracker.blockchainInfoLastBlock : -1)
    const freshness = XChainUtxoTracker.computeFreshness(committedHeight, rawTip, tracker.isSynced(), {
        mempoolReconverged: tracker.isMempoolReconverged(),
        halted: !!tracker.halted,
        haltReason: tracker.haltReason,
        haltedAt: tracker.haltedAt,
        haltedHeight: tracker.haltedHeight
    })
    freshness.node_catching_up = (tracker && tracker.nodeCatchingUp) || null
    const reach = nodeReachabilityFields(tracker)
    freshness.node_last_ok_at = reach.node_last_ok_at
    freshness.node_unreachable = reach.node_unreachable
    freshness.reorg_count = (tracker && typeof tracker.reorgCount === 'number')
        ? tracker.reorgCount : undefined
    if (freshness.reorg_count === undefined) delete freshness.reorg_count
    return freshness
}

// Stamp freshness onto REST headers without changing the existing body shape.
async function setFreshnessHeaders(tracker, res){
    const f = await getFreshnessMeta(tracker)
    res.set('X-Tracker-Height', String(f.tracker_height))
    res.set('X-Node-Height', String(f.node_height))
    if (f.lag !== null) res.set('X-Sync-Lag', String(f.lag))
    res.set('X-Synced', String(f.synced))
    return f
}

// Use Helmet to increase security

// Allow JSON requests

// CORS disabled by default. CORS_ORIGIN is a comma-separated ALLOWLIST, not a
// single origin: handing `cors` the raw string makes it echo that string
// verbatim to every caller, a multi-value header no browser accepts, so every
// listed origin is blocked while the header reads as configured. Parsing is
// what makes the list work; see src/corsOrigin.js.

// Trust only the first proxy hop so the rate limiter keys on the real client
// IP rather than the fronting proxy (and to satisfy express-rate-limit's
// proxy validation).

// Per-IP rate limit on every route (REST reads + JSON-RPC). The REST read
// routes below carry no auth of their own, so anything that can reach the
// port could otherwise drive unbounded backing-DB work. Mirrors the per-IP
// limiter every peer service front-loads (explorer/hub/decoder/encoder);
// override the 500 rpm default with UTXO_TRACKER_RATE_LIMIT_RPM.

// Global in-flight concurrency cap. The limiter above keys on the
// client IP, so a stampede spread across thousands of distinct IPs never
// trips it while still driving unbounded concurrent LevelDB scans (an
// /utxos/:address read walks the address index). This caps how many
// requests are being served at any instant across ALL callers and sheds
// the excess with an immediate 429 instead of queueing it behind an
// already-saturated store. Override with
// UTXO_TRACKER_MAX_CONCURRENT_REQUESTS; 0 disables the cap.
//
// GET /status is the readiness probe Docker and the monitors poll, so it
// must stay answerable while the main gate sheds: a tracker that 429s its
// own healthcheck gets restarted instead of being allowed to shed. It gets
// a small private reserve rather than a blanket exemption, because it still
// does a LevelDB read and an uncapped exempt route is just where the
// stampede would move next.
// Must match exactly the set Express routes to the `/status` handler below.
// Under the default routing options the app runs with, a bare `app.get`
// also answers HEAD, a trailing slash, and any letter case, so a stricter
// predicate here admits those variants on the MAIN gate while the handler
// is wrapped in probeGate.hold(): hold() finds no slot under its own gate's
// key, degrades to a pass-through, and the main slot is freed by the socket
// 'close' leg while the LevelDB read is still running (item 7712). Same
// root cause, second symptom: a HEAD healthcheck charged to the 100-slot
// main cap can be shed with 429, which is the restart thrash the reserve
// exists to prevent. Changing this route, adding a /status alias, or
// enabling strict/case-sensitive routing means changing both sites.

// Prometheus /metrics plus a structured log shim, both DEFAULT OFF.
// Nothing is registered and no timer starts unless METRICS_ENABLED (and, for
// log shipping, LOG_SHIP_ENABLED + LOG_SHIP_URL) are set. Wired AFTER the
// rate limiter and concurrency gates on purpose: an enabled scrape endpoint
// sheds like every other route. The request-timing middleware hoists itself
// to the front of the stack so it still measures the routes above.
// See src/observability/README.md.

// Sync-freshness heartbeat. Commit recency, halt state and reorg counters
// live in get_sync_status / GET /status only, so a wedged or halted tracker
// leaves no trace on the scrape and is undetectable if that polling rail
// itself regresses. Registration is unconditional: the registry is always
// built and only the /metrics route is gated, so the series exist even where
// METRICS_ENABLED is off; their values come from a scrape-time collector, so
// they are sampled only once something scrapes. See src/utxoTrackerMetrics.js.

// API key enforcement for admin JSON-RPC methods. Fails closed: without a
// configured key these methods are rejected, never left open.
//
// Both a single request (body is an object) and a JSON-RPC batch (body is
// an array) reach the router below, and the router executes every entry of
// a batch. So the guard must inspect EVERY method in the request, not just
// req.body.method: for an array body req.body.method is undefined, so without
// this guard an admin method smuggled inside a batch (e.g.
// [{"method":"restorebootstrap",...}]) skips the key check entirely and runs
// unauthenticated. Gate the whole request when ANY entry is an admin method.

// Bound batch fan-out BEFORE the router's uncapped Promise.all executes every
// entry: an over-cap array is an amplification vector, not a legitimate request.

// Every route below that awaits a LevelDB read is wrapped in the gate's
// hold(): the slot then spans the read instead of the client's socket, so a
// client that hangs up mid-scan cannot free capacity for the next request
// while its own scan is still running. Adding a route here without the
// wrapper puts it back outside the cap.

function installBaseMiddleware(app, config) {
    config.installUnmatchedRouteLabel(app)
    app.use(helmet())
    app.use(bodyParser.json())
    app.use(cors({ origin: parseCorsOrigin(config.CORS_ORIGIN) }))
    app.set('trust proxy', 1)
    app.use(rateLimit({
        windowMs: 60 * 1000,
        limit: parseInt(config.UTXO_TRACKER_RATE_LIMIT_RPM, 10) || 500,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Too many requests', code: 'RATE_LIMITED' }
    }))
}

// GET /status has a private reserve so it stays answerable while the main gate
// sheds. The predicate matches Express route semantics for HEAD, slash, and case.
function installConcurrencyGates(app, config) {
    const probePath = /^\/status\/?$/i
    const isProbe = (req) => (req.method === 'GET' || req.method === 'HEAD') && probePath.test(req.path)
    const busyBody = { error: 'Server busy, retry shortly', code: 'SERVER_BUSY' }
    const probeGate = concurrencyGate.createConcurrencyGate({
        limit: concurrencyGate.resolveLimit(config.UTXO_TRACKER_MAX_CONCURRENT_PROBES, 16),
        retryAfter: 1,
        skip: (req) => !isProbe(req),
        body: busyBody
    })
    app.use(probeGate)
    const requestGate = concurrencyGate.createConcurrencyGate({
        limit: concurrencyGate.resolveLimit(config.UTXO_TRACKER_MAX_CONCURRENT_REQUESTS, 100),
        retryAfter: 1,
        skip: isProbe,
        body: busyBody
    })
    app.use(requestGate)
    return { probeGate, requestGate }
}

// Registration is unconditional so scrape-time freshness gauges exist whenever
// metrics is enabled. The /metrics route itself remains default off.
function installMetrics(app, tracker, config) {
    let trackerVersion = ''
    try { trackerVersion = require('../../package.json').version } catch { /* version label is cosmetic */ }
    const observability = installObservability(app, {
        service: 'xchain-utxo-tracker', version: trackerVersion,
        coin: config.COIN || '', network: config.NETWORK || ''
    })
    installUtxoTrackerMetrics(observability, tracker)
}

// Gate the whole JSON-RPC request if any batch entry names an admin method.
function installAdminGuard(app, config) {
    app.use((req, res, next) => {
        const body = req.body
        if(Array.isArray(body) && body.length > config.MAX_JSONRPC_BATCH){
            return res.status(400).json({
                jsonrpc: '2.0', id: null,
                error: { code: -32600, message: 'Batch too large (max ' + config.MAX_JSONRPC_BATCH + ' requests per call)' }
            })
        }
        const entries = Array.isArray(body) ? body : [body]
        const wantsAdmin = entries.some(e =>
            e && typeof e.method === 'string' && config.ADMIN_METHODS.has(e.method.toLowerCase()))
        if(wantsAdmin){
            const header = req.headers['authorization']
            if(!config.UTXO_TRACKER_API_KEY || !header
                || !config.keyEquals(header, 'Bearer ' + config.UTXO_TRACKER_API_KEY)){
                return res.status(401).json({
                    jsonrpc: '2.0', id: (!Array.isArray(body) && body && body.id) || null,
                    error: { code: -32001, message: 'Unauthorized' }
                })
            }
        }
        next()
    })
}

function listen(app, tracker, trackerExited, config) {
    const server = app.listen(config.UTXO_TRACKER_API_PORT, () => {
        logger.info('API listening on port ' + config.UTXO_TRACKER_API_PORT)
        logger.info(memoryBudget.describe(config.BULK_SYNC_RAM_BUDGET))
    })
    const shutdown = createShutdown({
        drain: createTrackerDrain({ tracker, server, loopSettled: trackerExited })
    })
    process.on('SIGTERM', () => shutdown('SIGTERM'))
    process.on('SIGINT', () => shutdown('SIGINT'))
}

async function startApi(config){
    const tracker = new XChainUtxoTracker(
        config.NETWORK, config.NODE_URL, config.NODE_PORT, config.NODE_USER,
        config.NODE_PASSWORD, config.DB_NAME, config.AUX_POW)
    const trackerExited = config.launchTracker(tracker)
    const app = express()
    installBaseMiddleware(app, config)
    const { probeGate, requestGate } = installConcurrencyGates(app, config)
    installMetrics(app, tracker, config)
    installAdminGuard(app, config)
    registerRoutes({
        app, tracker, probeGate, requestGate,
        getUtxos: (address, opts) => getUtxos(tracker, address, opts),
        getFirstSeen: (address) => getFirstSeen(tracker, address),
        getBalance: (address) => getBalance(tracker, address),
        getInfo: (address) => getInfo(tracker, address),
        parsePageOpts: (query) => parsePageOpts(query, config.MAX_PAGE_LIMIT),
        getFreshnessMeta: (height) => getFreshnessMeta(tracker, height),
        setFreshnessHeaders: (res) => setFreshnessHeaders(tracker, res),
        DB_NAME: config.DB_NAME,
        launchTracker: config.launchTracker
    })
    listen(app, tracker, trackerExited, config)
}

module.exports = { startApi }
