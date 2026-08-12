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
 * XChain UTXO Tracker - API
 * 
 * This file parses in environmental variables and starts up the utxo tracker instance
 * 
 ********************************************************************/

// Load required libraries
const dotenv = require('dotenv')
dotenv.config()

const { spawn, spawnSync } = require('child_process');
const os = require('os')
const LevelUpStore = require('./LevelUpDb.js')
const fs = require('fs')
const express = require('express');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const XChainUtxoTracker  = require('./XChainUtxoTracker');
const BlockchainConnector = require('./BlockchainConnector');
const { resolveUndoBlocks } = require('./bulk-sync/merger/derive-keys.js')
const { handleBootstrapFailure, handleRestoreFailure } = require('./bootstrap-recovery.js')
const { isWrapperArchive, parseSha256Sidecar,
        hasRequiredLevelDbMembers, parseDetachedSignature } = require('./restore-validation.js')
const { installObservability } = require('./observability');   // : default-off /metrics + structured log shim
const jsonRouter = require('express-json-rpc-router')
const concurrencyGate = require('./concurrencyGate.js')
const { parseCorsOrigin } = require('./corsOrigin.js')
const { randomUUID, timingSafeEqual, createHash,
        createPublicKey, verify: verifyAsymmetric } = require('crypto')
const path = require('path')

const NETWORK = process.env.NETWORK
const NODE_URL =  process.env.NODE_URL
const NODE_PORT =  process.env.NODE_PORT
const NODE_USER =  process.env.NODE_USER
const NODE_PASSWORD =  process.env.NODE_PASSWORD
const UTXO_TRACKER_API_PORT = process.env.UTXO_TRACKER_API_PORT
const DB_NAME =  "xchain-utxo-tracker"
const AUX_POW = process.env.AUX_POW === 'true' || process.env.AUX_POW === '1'

// API key for admin JSON-RPC methods (DB bootstrap snapshot/restore and raw
// key scans). These methods fail closed (401) when no key is configured;
// read-only UTXO/balance queries stay open for the encoder/indexer.
const UTXO_TRACKER_API_KEY = process.env.UTXO_TRACKER_API_KEY || ''

// Platform-wide no-API-key posture : running keyless is allowed, but the
// service must say so loudly at boot instead of failing silently open/closed.
if(!UTXO_TRACKER_API_KEY){
    console.warn('WARNING: UTXO_TRACKER_API_KEY is not set. Admin JSON-RPC methods (bootstrap snapshot/restore, raw key scans) are DISABLED (fail closed); read-only UTXO/balance queries remain open. Set a key to enable admin methods.')
}

// Constant-time comparison for the admin Bearer key. A plain `!==` short-circuits
// at the first mismatching byte, leaking the key through response-time
// differences; timingSafeEqual needs equal-length buffers, so length is guarded
// first (a length mismatch is not itself the secret).
function keyEquals(provided, expected){
    const a = Buffer.from(String(provided == null ? '' : provided))
    const b = Buffer.from(String(expected == null ? '' : expected))
    if(a.length !== b.length) return false
    return timingSafeEqual(a, b)
}
const ADMIN_METHODS = new Set([
    'getbootstrap', 'getbootstrapstatus',
    'restorebootstrap', 'getbootstraprestorestatus',
    'get_input_from_key_pattern'
])

// Largest JSON-RPC batch (array body) accepted. express-json-rpc-router runs
// Promise.all over every array element, so without a cap a single unauthenticated
// ~100kb POST fans out into thousands of concurrent read scans / node RPCs (each
// get_balance can accumulate up to MAX_ADDRESS_OUTPUTS objects; each get_sync_status
// fires a node RPC), amplifying one request into a heap-exhaustion / backend-load DoS.
// Mirrors the decoder/encoder batch guard. Tunable via UTXO_MAX_RPC_BATCH.
const MAX_JSONRPC_BATCH = Number(process.env.UTXO_MAX_RPC_BATCH) > 0
    ? Number(process.env.UTXO_MAX_RPC_BATCH) : 20

// Largest page a single ?limit= request may ask for. Caps page size so a caller
// can't re-introduce the OOM by requesting one giant page. Independent of the
// tracker's MAX_ADDRESS_OUTPUTS safety ceiling (which bounds *unbounded* scans).
const MAX_PAGE_LIMIT = Number(process.env.UTXO_MAX_PAGE_LIMIT) > 0
    ? Math.floor(Number(process.env.UTXO_MAX_PAGE_LIMIT))
    : 10000

// Bulk-sync pre-flight (activates on empty DB). See runBulkSyncIfEmpty below.
const BULK_SYNC_WORKERS      = process.env.BULK_SYNC_WORKERS      || '6'
const BULK_SYNC_CHUNK_SIZE   = process.env.BULK_SYNC_CHUNK_SIZE   || '10000'
const BULK_SYNC_RAM_BUDGET   = process.env.BULK_SYNC_RAM_BUDGET   || '4096'
const BULK_SYNC_TIP_SAFETY   = process.env.BULK_SYNC_TIP_SAFETY   || '10'
const BULK_SYNC_BATCH_SIZE   = process.env.BULK_SYNC_BATCH_SIZE   || '10000'
const BULK_SYNC_WORK_DIR     = process.env.BULK_SYNC_WORK_DIR     || path.join('/data', DB_NAME, '_bulk-sync-work')
const BULK_SYNC_NODE_POLL_MS = 30000

var tasks = {}

// Serializes bootstrap/restore operations. Both getbootstrap and restorebootstrap
// stopParsing() then wipe/read /data via pigz+tar; two overlapping calls (a fresh
// randomUUID task each) would run two `tar` processes into the same directory and
// corrupt the live LevelDB. stopParsing() is idempotent (guards only on
// parsingStopped) so it is NOT a mutex. This flag rejects a second op while one is
// in flight; it is cleared in every completion path (.then success, .catch failure,
// and the synchronous throw path).
var bootstrapBusy = false

// Launch the tracker polling loop with the top-level guard. start() is intentionally not
// awaited (the Express server must come up alongside it), so without this .catch() any
// throw out of the loop (a malformed-block decode, a verifyReorg fail-stop, a transient
// DB I/O fault) becomes a bare unhandledRejection: no clean rollback and an unclear log.
// Roll back any open LevelDB batch, then split by fault class. TRANSIENT fatals
// (malformed decode, DB I/O blip, block-fetch desync) exit non-zero so the
// orchestrator restarts cleanly with the reason in the logs. An UNRECOVERABLE
// reorg (rolled back past the UNDO_BLOCKS window) is NOT transient: a restart
// re-hits the same on-disk stale tip and fails identically, so exiting just
// crash-loops forever under Docker unless-stopped (the observed 5000+ restarts).
// For that class, halt in place instead: the process stays up, /status returns
// 503, and an operator resyncs (restorebootstrap) against a stable process. Used
// at EVERY start() site (primary boot + bootstrap/restore restarts) so none can
// regress to a bare unhandledRejection that skips the rollback.
function launchTracker(tracker){
    tracker.start().catch((err) => {
        try { if (tracker.db && tracker.db.endTransaction) tracker.db.endTransaction(false) } catch (_) {}
        if (XChainUtxoTracker.isUnrecoverableReorg(err)) {
            tracker.haltForResync(err && err.message)
            return
        }
        console.error('[fatal] UTXO tracker polling loop terminated: ' + (err && err.message), err)
        process.exit(1)
    })
}

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
const NODE_RPC_STALE_MS = parseInt(process.env.UTXO_TRACKER_NODE_RPC_STALE_MS, 10) || 150000

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
// let orphaned UTXOs reach PSBT selection (). Pure and exported so the
// bound is unit-testable without a running server.
function deriveSyncedVerdict({ lag, nodeHeightStale = false, threshold = XChainUtxoTracker.SYNCED_THRESHOLD } = {}) {
    if (nodeHeightStale) return false
    if (typeof lag !== 'number' || !Number.isFinite(lag)) return false
    return lag >= 0 && lag <= threshold
}

async function startApi(){
    //Start the tracker
    const tracker = new XChainUtxoTracker(NETWORK, NODE_URL, NODE_PORT, NODE_USER, NODE_PASSWORD, DB_NAME, AUX_POW);
    launchTracker(tracker)

    async function getUtxos(address, opts){
        return await tracker.getUtxosAddress(address, opts)
    }

    // Parse optional ?limit=&after= pagination params into tracker opts. Throws a
    // BAD_REQUEST-coded error on a malformed limit so the route returns HTTP 400.
    function parsePageOpts(query){
        const opts = {}
        if (query && query.limit != null && query.limit !== '') {
            const n = Number(query.limit)
            if (!Number.isInteger(n) || n <= 0) {
                const e = new Error('limit must be a positive integer')
                e.code = 'BAD_REQUEST'
                throw e
            }
            opts.limit = Math.min(n, MAX_PAGE_LIMIT)
        }
        if (query && query.after != null && query.after !== '') opts.after = String(query.after)
        return opts
    }

    // Map address-query errors to HTTP status codes. ADDRESS_TOO_LARGE -> 413 (use
    // pagination); malformed cursor/limit -> 400; everything else -> 500. Without
    // this, an unbounded mega-address query would have OOM-crashed the process.
    function sendAddressError(res, err){
        const code = err && err.code
        if (code === 'ADDRESS_TOO_LARGE') {
            res.status(413).json({ error: err.message, code })
        } else if (code === 'INVALID_CURSOR' || code === 'BAD_REQUEST') {
            res.status(400).json({ error: err.message, code })
        } else {
            console.error('Address query failed:', err)
            res.status(500).json({ error: (err && err.message) || 'internal error' })
        }
    }

    async function getFirstSeen(address){
        return await tracker.getFirstSeen(address)
    }
    
    async function getBalance(address){
        let utxos = await tracker.getUtxosAddress(address)
        let balance = 0n

        for (let nextUtxo of utxos){
            balance = balance + BigInt(nextUtxo.value)
        }

        // Return balance
        return XChainUtxoTracker.satoshiToDecimalString(balance)
    }
    
    async function getInfo(address){
        let infoAddress = await tracker.getBalanceInfo(address)

        return infoAddress
    }

    // Per-query freshness surface (seam finding M-11). UTXO/balance results are
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
    // an RPC caller gates on the same facts a REST caller can ().
    async function getFreshnessMeta(){
        let committedHeight = -1;
        try { committedHeight = await tracker.db.getLastBlockHeight(); } catch (e) {}
        const rawTip = (typeof tracker.latestKnownChainTip === 'number')
            ? tracker.latestKnownChainTip
            : (typeof tracker.blockchainInfoLastBlock === 'number' ? tracker.blockchainInfoLastBlock : -1);
        return XChainUtxoTracker.computeFreshness(committedHeight, rawTip, tracker.isSynced(), {
            mempoolReconverged: tracker.isMempoolReconverged(),
            halted:             !!tracker.halted,
            haltReason:         tracker.haltReason
        });
    }

    // Stamp the freshness fields onto a REST response as headers, leaving the
    // existing body shape untouched (additive, backward-compatible). X-Sync-Lag
    // is omitted entirely when lag is unknown (null) rather than sent as a
    // misleading 0.
    async function setFreshnessHeaders(res){
        const f = await getFreshnessMeta();
        res.set('X-Tracker-Height', String(f.tracker_height));
        res.set('X-Node-Height', String(f.node_height));
        if (f.lag !== null) res.set('X-Sync-Lag', String(f.lag));
        res.set('X-Synced', String(f.synced));
        return f;
    }

    // Create the app
    const app = express();

    // Use Helmet to increase security
    app.use(helmet());

    // Allow JSON requests
    app.use(bodyParser.json());

    // CORS disabled by default. CORS_ORIGIN is a comma-separated ALLOWLIST, not a
    // single origin: handing `cors` the raw string makes it echo that string
    // verbatim to every caller, a multi-value header no browser accepts, so every
    // listed origin is blocked while the header reads as configured. Parsing is
    // what makes the list work; see src/corsOrigin.js .
    app.use(cors({ origin: parseCorsOrigin(process.env.CORS_ORIGIN) }));

    // Trust only the first proxy hop so the rate limiter keys on the real client
    // IP rather than the fronting proxy (and to satisfy express-rate-limit's
    // proxy validation).
    app.set('trust proxy', 1);

    // Per-IP rate limit on every route (REST reads + JSON-RPC). The REST read
    // routes below carry no auth of their own, so anything that can reach the
    // port could otherwise drive unbounded backing-DB work. Mirrors the per-IP
    // limiter every peer service front-loads (explorer/hub/decoder/encoder);
    // override the 500 rpm default with UTXO_TRACKER_RATE_LIMIT_RPM.
    app.use(rateLimit({
        windowMs:        60 * 1000,
        limit:           parseInt(process.env.UTXO_TRACKER_RATE_LIMIT_RPM, 10) || 500,
        standardHeaders: true,
        legacyHeaders:   false,
        message:         { error: 'Too many requests', code: 'RATE_LIMITED' },
    }));

    // Global in-flight concurrency cap . The limiter above keys on the
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
    const isProbe = (req) => req.method === 'GET' && req.path === '/status';
    const BUSY_BODY = { error: 'Server busy, retry shortly', code: 'SERVER_BUSY' };

    const probeGate = concurrencyGate.createConcurrencyGate({
        limit:      concurrencyGate.resolveLimit(process.env.UTXO_TRACKER_MAX_CONCURRENT_PROBES, 16),
        retryAfter: 1,
        skip:       (req) => !isProbe(req),
        body:       BUSY_BODY
    });
    app.use(probeGate);

    const requestGate = concurrencyGate.createConcurrencyGate({
        limit:      concurrencyGate.resolveLimit(process.env.UTXO_TRACKER_MAX_CONCURRENT_REQUESTS, 100),
        retryAfter: 1,
        skip:       isProbe,
        body:       BUSY_BODY
    });
    app.use(requestGate);

    // : Prometheus /metrics plus a structured log shim, both DEFAULT OFF.
    // Nothing is registered and no timer starts unless METRICS_ENABLED (and, for
    // log shipping, LOG_SHIP_ENABLED + LOG_SHIP_URL) are set. Wired AFTER the
    // rate limiter and concurrency gates on purpose: an enabled scrape endpoint
    // sheds like every other route. The request-timing middleware hoists itself
    // to the front of the stack so it still measures the routes above.
    // See src/observability/README.md.
    let trackerVersion = '';
    try { trackerVersion = require('../package.json').version; } catch { /* version label is cosmetic */ }
    installObservability(app, {
        service: 'xchain-utxo-tracker',
        version: trackerVersion,
        coin:    process.env.COIN || '',
        network: NETWORK || ''
    });

    // API key enforcement for admin JSON-RPC methods. Fails closed: without a
    // configured key these methods are rejected, never left open.
    //
    // Both a single request (body is an object) and a JSON-RPC batch (body is
    // an array) reach the router below, and the router executes every entry of
    // a batch. So the guard must inspect EVERY method in the request, not just
    // req.body.method: for an array body req.body.method is undefined, which
    // previously let an admin method smuggled inside a batch (e.g.
    // [{"method":"restorebootstrap",...}]) skip the key check entirely and run
    // unauthenticated. Gate the whole request when ANY entry is an admin method.
    app.use((req, res, next) => {
        const body = req.body;
        // Bound batch fan-out BEFORE the router's uncapped Promise.all executes every
        // entry: an over-cap array is an amplification vector, not a legitimate request.
        if(Array.isArray(body) && body.length > MAX_JSONRPC_BATCH){
            return res.status(400).json({
                jsonrpc: '2.0', id: null,
                error: { code: -32600, message: 'Batch too large (max ' + MAX_JSONRPC_BATCH + ' requests per call)' }
            });
        }
        const entries = Array.isArray(body) ? body : [body];
        const wantsAdmin = entries.some(e =>
            e && typeof e.method === 'string' && ADMIN_METHODS.has(e.method.toLowerCase()));
        if(wantsAdmin){
            let header = req.headers['authorization'];
            if(!UTXO_TRACKER_API_KEY || !header || !keyEquals(header, 'Bearer ' + UTXO_TRACKER_API_KEY)){
                return res.status(401).json({
                    jsonrpc: '2.0', id: (!Array.isArray(body) && body && body.id) || null,
                    error: { code: -32001, message: 'Unauthorized' }
                });
            }
        }
        next();
    });

    app.get('/utxos/:address', async (req, res) => {
        const address = req.params.address;
        try {
            const utxos = await getUtxos(address, parsePageOpts(req.query));
            // Freshness surface: tip height / sync lag so callers can gate on
            // how stale this committed view is (see setFreshnessHeaders).
            const freshness = await setFreshnessHeaders(res);
            // Signal mempool readiness so callers can distinguish a genuinely empty
            // result from one served before the in-memory mempool has reconverged
            // after a restart. Body shape (a bare array) is left unchanged.
            // Read off the freshness meta rather than raw isSynced(): computeFreshness
            // floors both verdicts on a negative lag (committed tip above the node's,
            // so the view is orphaned), and the raw pair does not, which put
            // X-Synced:false beside X-Mempool-Ready:true on the same response
            // ().
            res.set('X-Mempool-Ready', String(freshness.mempool_ready));
            // Continuation cursor for paginated requests (?limit=). Absent when not
            // paginating or when the final page has been reached.
            if (utxos && utxos.nextCursor) res.set('X-Next-Cursor', String(utxos.nextCursor));
            res.send(utxos);
        } catch (err) {
            sendAddressError(res, err);
        }
    })

    app.get('/firstseen/:address', async (req, res) => {
        const address = req.params.address;
        try {
            const firstSeen = await getFirstSeen(address);
            await setFreshnessHeaders(res);
            res.send(firstSeen);
        } catch (err) {
            sendAddressError(res, err);
        }
    })

    app.get('/balance/:address', async (req, res) => {
        const address = req.params.address;
        try {
            const balance = await getBalance(address);
            // See /utxos above: expose mempool readiness via header (off the floored
            // freshness meta) without altering the existing bare-number body.
            const freshness = await setFreshnessHeaders(res);
            res.set('X-Mempool-Ready', String(freshness.mempool_ready));
            res.send(balance);
        } catch (err) {
            sendAddressError(res, err);
        }
    })

    app.get('/info/:address', async (req, res) => {
        const address = req.params.address;
        try {
            const info = await getInfo(address);
            // info is a JSON object, so expose readiness both in-body (additive
            // field) and via header. A false value means the in-memory mempool is
            // still reconverging after a restart and `balances.pending` may be
            // understated; callers should not treat pending=0 as authoritative yet.
            // Freshness surface, both as headers and (since the body is already a
            // JSON object) an additive `sync` field callers can gate on.
            const freshness = await setFreshnessHeaders(res);
            // Off the floored meta, same reason as /utxos: an orphaned view must not
            // publish X-Synced:false beside X-Mempool-Ready:true ().
            res.set('X-Mempool-Ready', String(freshness.mempool_ready));
            if (info && typeof info === 'object') info.mempool_ready = freshness.mempool_ready;
            if (info && typeof info === 'object') info.sync = freshness;
            res.send(info);
        } catch (err) {
            sendAddressError(res, err);
        }
    })

    const jsonRpcController = {

        // Function to check if xchain-utxo-tracker is up
        async ping() {
            return {status:"success"};
        },

        // ── Readiness contract ─────────────────────────────────────────
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
        // ───────────────────────────────────────────────────────────────

        // Sync-status probe: tracker tip vs node tip. Used by e2e tests and
        // ops tooling to diagnose lag when an address's funding tx looks lost.
        // `tracker_height` and `committed_height` are aliases, both report
        // the last committed block. `committed_height` is the canonical name
        // going forward; `tracker_height` retained for existing callers.
        async get_sync_status() {
            let committedHeight = -1;
            try { committedHeight = await tracker.db.getLastBlockHeight(); } catch (e) {}

            let nodeHeight = -1;
            let nodeHeightStale = false;
            try {
                const info = await tracker.connector.getBlockchainInfo();
                nodeHeight = info['blocks'];
            } catch (e) {
                const rawTip = tracker.latestKnownChainTip ?? tracker.blockchainInfoLastBlock;
                nodeHeight = (typeof rawTip === 'number') ? rawTip : -1;
                nodeHeightStale = true;
            }

            const lag = (nodeHeight >= 0 && committedHeight >= 0) ? (nodeHeight - committedHeight) : null;
            const result = {
                committed_height: committedHeight,
                tracker_height:   committedHeight,
                node_height:      nodeHeight,
                lag:              lag,
                // Authoritative sync verdict computed against the tracker's own
                // SYNCED_THRESHOLD so callers don't replicate the threshold. The policy
                // (null lag, stale node height and negative lag are all not-synced) lives
                // in deriveSyncedVerdict above, where it is unit-testable.
                synced:           deriveSyncedVerdict({ lag, nodeHeightStale })
            };
            // Spendability is block sync AND a reconverged mempool, the same pair REST
            // gates X-Mempool-Ready on and get_utxos' freshness sibling now carries.
            // Published here too because this method is the ONLY tracker surface the
            // encoder's serve-readiness probe reads: without the field that probe could
            // not mirror create_tx's UTXO_TRACKER_NOT_READY refusal, and /status painted
            // the encoder healthy for the whole restart window in which create_tx refuses
            // every request (, the same divergence #2263 fixed for lag).
            result.mempool_ready = result.synced && tracker.isMempoolReconverged() === true;
            if (nodeHeightStale) result.node_height_stale = true;
            // Surface mempool RPC health so operators can detect a node that is
            // degraded on mempool fetches without watching the console log.
            if (tracker.mempoolRpcFailures > 0) {
                result.mempool_rpc_failures  = tracker.mempoolRpcFailures;
                result.last_mempool_error_at = tracker.lastMempoolErrorAt;
            }
            // Surface reorg counters so operators can detect chains with
            // frequent reorganizations and know the depth of the last one.
            result.reorg_count      = tracker.reorgCount;
            result.last_reorg_depth = tracker.lastReorgDepth;
            // Surface an unrecoverable block-fetch desync (M-10) so a monitor can
            // name the fault. Set just before the polling loop fails loud on a node
            // pruned past our cursor; visible in the brief window before exit.
            if (tracker.blockFetchDesync) result.block_fetch_desync = tracker.blockFetchDesync;
            // Halted (unrecoverable reorg): persists, since the tracker no longer
            // exits on this fault but halts in place, so a monitor can alert and an
            // operator can resync. /status also returns 503 while halted.
            if (tracker.halted) {
                result.halted = true;
                result.halt_reason = tracker.haltReason;
            }
            return result;
        },

        // Health probe: the richest surface a consumer gates on (lag plus halt
        // markers), matching xchain-decoder's and xchain-indexer's health().
        // Delegates to get_sync_status so the lag math and SYNCED_THRESHOLD stay
        // defined in one place. xchain-node's BootstrapHealthGate probes this
        // method first and falls back to GET /status, which carries no lag field
        // at all; without this method that gate's lag refusal silently never
        // fired and a badly lagging tracker certified as a bootstrap source
        // ().
        async health() {
            const sync = await jsonRpcController.get_sync_status();
            // Same reachability read GET /status runs: a missing or unreachable
            // store throws here, so it reports unhealthy instead of passing a
            // bare committed_height of -1 off as a healthy empty tracker.
            let dbOk = false;
            try { await tracker.db.getLastBlockHeight(); dbOk = true; } catch (e) {}
            return { status: deriveHealthStatus({ halted: !!tracker.halted, dbOk }), db: dbOk, ...sync };
        },

        // Quiescence probe: returns ready=true iff every previously-broadcast
        // tx is mined-and-indexed AND the tracker has no in-flight batch.
        // Test framework barrier: callers can poll this between e2e tests so
        // the next test starts from a fully-settled stack instead of inheriting
        // hidden state (unflushed batch, mempool backlog) that caused
        // ordering-dependent flakes.
        //
        // Conditions:
        //   1. node-side mempool is empty (no unmined txs the tracker is
        //      blind to until the next MEMPOOL_INTERVAL poll)
        //   2. node tip == tracker's last-committed height (setLastBlockHeight
        //      only commits via endTransaction, so this naturally returns
        //      false during a mid-batch state)
        async is_quiescent() {
            let mempoolSize = -1;
            let trackerHeight = -1;
            let nodeHeight = -1;
            try {
                const mempool = await tracker.connector.getRawMempool();
                mempoolSize = Array.isArray(mempool) ? mempool.length
                            : (mempool && typeof mempool === 'object') ? Object.keys(mempool).length
                            : 0;
            } catch (e) { /* leave -1; caller treats as not-ready */ }
            try { trackerHeight = await tracker.db.getLastBlockHeight(); } catch (e) {}
            try {
                const info = await tracker.connector.getBlockchainInfo();
                nodeHeight = (info && typeof info.blocks === 'number') ? info.blocks : -1;
            } catch (e) {}
            const heightAligned = (nodeHeight >= 0 && trackerHeight >= 0 && nodeHeight === trackerHeight);
            const mempoolEmpty  = (mempoolSize === 0);
            return {
                ready:            heightAligned && mempoolEmpty,
                mempool_size:     mempoolSize,
                committed_height: trackerHeight,
                tracker_height:   trackerHeight,
                node_height:      nodeHeight,
                lag:              (nodeHeight >= 0 && trackerHeight >= 0) ? (nodeHeight - trackerHeight) : null
            };
        },

        // Function to create transactions hex for a given data and encoding type.
        // Optional limit/after page the result; omitted = full set (capped by the
        // tracker's MAX_ADDRESS_OUTPUTS safety ceiling). nextCursor is returned only
        // when paginating and more rows remain; existing callers ignore it.
        async get_utxos({address, limit, after}) {
            let utxos = await getUtxos(address, parsePageOpts({ limit, after }))

            const result = { utxos: utxos }
            if (utxos && utxos.nextCursor) result.nextCursor = utxos.nextCursor
            // Freshness surface (M-11): additive sibling field so callers can gate
            // on committed height / lag without a separate get_sync_status round-trip.
            result.sync = await getFreshnessMeta()
            return result
        },
        // Function to retrieve the height of the block where an address was first seen
        async get_first_seen({address}) {
            return await getFirstSeen(address)
        },
        
        async get_balance({address}) {
            let balance = await getBalance(address)

            // Return balance; sync is an additive freshness surface (M-11).
            return { balance: balance, sync: await getFreshnessMeta() }
        },

        // Function to retrieve the confirmed, pending balances of an address
        async get_info({address}) {
            const info = await getInfo(address)
            // Additive freshness surface (M-11); leaves existing fields intact.
            if (info && typeof info === 'object') info.sync = await getFreshnessMeta()
            return info
        },
        
        async get_input_from_key_pattern({pattern}) {
            if (typeof pattern !== 'string' || pattern.length < 32){
                return {error: "pattern is too short"}
            } else if (!/^[0-9a-fA-F]+$/.test(pattern)){
                // Buffer.from(str, 'hex') silently truncates at the first non-hex
                // character, so e.g. 32 'g's would decode to an EMPTY prefix and
                // scan the entire database. Reject non-hex before it decodes.
                return {error: "pattern must be a hex string"}
            } else {
                // maxValues caps the scan the same way MAX_ADDRESS_OUTPUTS bounds
                // unbounded address queries: fail loud instead of OOMing.
                let results = await tracker.db.getValuesFromKeyPattern(pattern,
                    { maxValues: XChainUtxoTracker.MAX_ADDRESS_OUTPUTS })

                // Return utxos
                return { result: results}
            }
        },
        
        async getbootstrap({filename}){
            console.log("A bootstrap was requested")
            if(bootstrapBusy) return { error: 'a bootstrap or restore operation is already in progress' }
            try { filename = safeBootstrapFilename(filename) }
            catch (e) { return { error: e.message } }
            let taskId = randomUUID()
            bootstrapBusy = true
            // stopParsing now leaves the tracker RUNNING when the stop times out
            // (it restores keepParsing), rejecting the promise. Guard the await so a
            // failed stop releases bootstrapBusy and surfaces the error, instead of
            // leaving the mutex stuck true (all future bootstrap/restore RPCs wedged)
            // while the tracker is in fact still indexing.
            try {
                await tracker.stopParsing()
            } catch (e) {
                bootstrapBusy = false
                return { error: 'could not pause the tracker for bootstrap: ' + (e && e.message ? e.message : e) }
            }
            try {
                console.log("Compressing the data...")
                let destination = "/bootstrap/xchain-utxo-tracker/"+filename
                tasks[taskId] = {"progress": 0, "filename": filename}//, last_block_index":}
                compressDirPigz(taskId, "/data/"+DB_NAME, destination).then((finished) =>{
                    tasks[taskId]["progress"] = 100
                    console.log("Starting the parsing again")
                    bootstrapBusy = false
                    launchTracker(tracker)
                }).catch(error => {
                    // Compression failed but /data is untouched: resume indexing so a
                    // failed snapshot never freezes the tracker, and keep the task
                    // record so a status poll surfaces the failure (M-9).
                    bootstrapBusy = false
                    handleBootstrapFailure({ tasks, taskId, error, relaunch: () => launchTracker(tracker) })
                })

                return {"task_id":taskId}
            } catch (err){
                console.log("Warning compression was not succesful: "+err)
                bootstrapBusy = false
                delete tasks[taskId]
                return {error: err}
            }
        },
        
        async getbootstrapstatus({taskid}){
            if (taskid in tasks){
                return tasks[taskid]
            } else {
                return {error:"taskid doesn't exist"}
            }
        },
        
        async restorebootstrap({filename}){
            console.log("A bootstrap restore was requested")
            if(bootstrapBusy) return { error: 'a bootstrap or restore operation is already in progress' }
            try { filename = safeBootstrapFilename(filename) }
            catch (e) { return { error: e.message } }
            let taskId = randomUUID()
            bootstrapBusy = true
            // See getbootstrap: a timed-out stop leaves the tracker running and
            // rejects, so release the mutex and surface the error rather than
            // wedging every future admin call with bootstrapBusy stuck true.
            try {
                await tracker.stopParsing()
            } catch (e) {
                bootstrapBusy = false
                return { error: 'could not pause the tracker for restore: ' + (e && e.message ? e.message : e) }
            }
            try {
                let source = "/bootstrap/xchain-utxo-tracker/"+filename
                tasks[taskId] = {"progress": 0, "filename": filename}
                decompressPigz(taskId, source, "/data/"+DB_NAME).then((finished) =>{
                    tasks[taskId]["progress"] = 100
                    console.log("Starting the parsing")
                    bootstrapBusy = false
                    launchTracker(tracker)
                }).catch(error => {
                    // decompressPigz wipes /data BEFORE extracting, so a POST-wipe
                    // failure leaves the on-disk DB partially wiped and untrustworthy:
                    // fail loud so the supervisor restarts into a clean recovery path
                    // (M-9). A PRE-wipe validation abort (error.preWipe) never touched
                    // /data, so handleRestoreFailure resumes indexing via relaunch
                    // instead of killing the process (#3192).
                    bootstrapBusy = false
                    handleRestoreFailure({ tasks, taskId, error,
                        failLoud: () => process.exit(1),
                        relaunch: () => launchTracker(tracker) })
                })

                return {"task_id":taskId}
            } catch (err){
                console.log("Warning decompression was not succesful: "+err)
                bootstrapBusy = false
                delete tasks[taskId]
                return {error: err}
            }
        },
        
        async getbootstraprestorestatus({taskid}){
            if (taskid in tasks){
                return tasks[taskid]
            } else {
                return {error:"taskid doesn't exist"}
            }
        }
    }

    // GET /status: lightweight health probe for Docker HEALTHCHECK and uptime
    // monitors. Runs the same DB read that get_sync_status uses to verify the
    // store is reachable and returns 503 when it is not. The JSON-RPC catch-all
    // would otherwise respond 200 to any GET (serving the method-not-found
    // error body), making a DB-down tracker appear healthy to healthchecks.
    app.get('/status', async (req, res) => {
        let dbOk = false
        let committedHeight = -1
        try {
            committedHeight = await tracker.db.getLastBlockHeight()
            dbOk = true
        } catch (err) {
            // DB unreachable; fall through to 503
        }
        // Halted (unrecoverable reorg): report unhealthy so Docker/monitors see the
        // degradation while the process stays up (no restart thrash; unless-stopped
        // only restarts on exit). Recovery is an operator resync via restorebootstrap.
        if (tracker.halted) {
            res.status(503)
            return res.json({ status: 'halted', halt_reason: tracker.haltReason, db: dbOk, committed_height: committedHeight })
        }
        // A readable store is not forward progress. The tracking loop retries a
        // failing getBlockchainInfo forever, so a coin node that is down or unsynced
        // freezes block tracking while LevelDB still answers and this probe still
        // said 'ok' (). Gate on the loop's own last usable tip read, in
        // memory: no RPC is issued from the probe, so the check adds no node load.
        const nodeRpcStale = isNodeRpcStale({ lastNodeRpcOkAt: tracker.lastNodeRpcOkAt })
        const status = !dbOk ? 'degraded' : (nodeRpcStale ? 'stalled' : 'ok')
        if (!dbOk || nodeRpcStale) res.status(503)
        // request_gate exposes the global concurrency cap and how many requests
        // it has shed ; a climbing shed count is the only outward sign
        // that a distinct-IP stampede is being refused.
        const body = { status, db: dbOk, committed_height: committedHeight, request_gate: requestGate.getStats(), probe_gate: probeGate.getStats() }
        if (nodeRpcStale) {
            body.node_rpc_stale = true
            body.stale_for_ms   = Date.now() - tracker.lastNodeRpcOkAt
        }
        res.json(body)
    })

    // Express 5 / body-parser 2.x leaves req.body undefined when a request carries
    // no JSON body (a GET, or a POST without application/json), whereas body-parser
    // 1.x set it to {}. express-json-rpc-router requires req.body to be an object or
    // it throws ("req.body is required"). Restore the {} default so unmatched requests
    // that fall through to this root-mounted router get a normal JSON-RPC error
    // response instead of crashing the request.
    app.use((req, res, next) => { if (req.body === undefined) req.body = {}; next(); });

    // Allow JSON-RPC requests
    app.use(jsonRouter({methods: jsonRpcController}))


    // Start the server
    app.listen(UTXO_TRACKER_API_PORT, () => {
      console.log('API listening on port '+UTXO_TRACKER_API_PORT)
    })
}

async function compressDirPigz(taskId, source, destination) {
    tasks[taskId] = {progress: 0, filename: destination}
  
    // Calculate source size with du
    const duProcess = spawn('du', ['-sb', source])
    let totalBytesString = ''

    duProcess.stdout.on('data', (data) => {
        totalBytesString += data.toString()
    })

    await new Promise((resolve, reject) => {
        duProcess.on('close', (code) => {
            if (code !== 0) {
                return reject(new Error(`Error obtaining source size with "du" command with code ${code}`))
            }
            resolve()
        })
        duProcess.on('error', (err) => reject(new Error(`Error with du command: ${err.message}`)))
    })

    const totalBytes = parseInt(totalBytesString.split('\t')[0], 10)

    if (isNaN(totalBytes) || totalBytes <= 0) {
        // KEEP the task record: this rejection is routed through getbootstrap's
        // .catch into handleBootstrapFailure, whose recordFailure is guarded on
        // tasks[taskId] and no-ops once the record is gone. Deleting here made
        // getbootstrapstatus answer "taskid doesn't exist" instead of the real
        // failure, defeating the M-9 invariant (). The du non-zero-exit
        // reject above already leaves the record intact; this branch now matches.
        console.error(`Error: Invalid size for source '${source}'.`)
        throw new Error(`Invalid size for source: ${totalBytes}`)
    }

    const tar = spawn('tar', ['-cf', '-', '-C', source, '.']) // -c: create, -f -: output to stdout
    const pv = spawn('pv', [
        '-s', totalBytes.toString(), // -s: expected total size,
        '-n', '-f' //-n: progress in number -f: force output
    ])   
    const pigz = spawn('pigz', ['-C', JSON.stringify({"original_size":totalBytes.toString()})]) //-C add a comment to the final file, this will be the original size to calculate progress when decompressing

    // Pipe all processes
    tar.stdout.pipe(pv.stdin) // tar sends data to pv
    pv.stdout.pipe(pigz.stdin)  // pv monitors data and sends it to pigz
    const outputStream = fs.createWriteStream(destination)
    pigz.stdout.pipe(outputStream) // pigz sends compress data to file

    // Monitors stderr from pv
    pv.stderr.on('data', (data) => {
        // handling pv progress
        const percentageString = data.toString().trim(); // pv -n prints the progress and a line break
        const currentPercentage = parseInt(percentageString, 10);
        
        if (!isNaN(currentPercentage)) { // Check if the percentage is a valid number
            tasks[taskId]["progress"] = currentPercentage
        }
    })

    // Error handling and finishing processes
    return new Promise((resolve, reject) => {
        let tarError = null
        let pvError = null
        let pigzError = null

        tar.on('close', (code) => {
            if (code !== 0) tarError = new Error(`tar throwed an error with código ${code}`)
        })
        pv.on('close', (code) => {
            if (code !== 0) pvError = new Error(`pv throwed an error with código ${code}`)
        })
        pigz.on('close', (code) => {
            if (code !== 0) pigzError = new Error(`pigz throwed an error with código ${code}`)

            // If there is an error reject the whole process
            if (tarError || pvError || pigzError) {
                reject(tarError || pvError || pigzError)
            } else {
                //console.log(`\nProcess completed. File: ${destination}`)
                // Write the .sha256 sidecar the single-layer restore path verifies
                // against (#2725), so restoring our OWN snapshot still gets a real
                // integrity check rather than needing BOOTSTRAP_RESTORE_ALLOW_UNVERIFIED=1.
                // sha256sum format (`<hex>  <name>`) so both parseSha256Sidecar and a
                // plain `sha256sum -c` accept it. This snapshot is UNSIGNED (no signing
                // key lives in the tracker container), so restoring it does need the
                // separate BOOTSTRAP_RESTORE_ALLOW_UNSIGNED=1 provenance opt-out (#4426):
                // a locally-produced archive has no publisher to authenticate.
                sha256File(destination)
                    .then((digest) => fs.promises.writeFile(
                        destination + '.sha256',
                        `${digest}  ${path.basename(destination)}\n`))
                    .then(() => resolve(destination))
                    .catch(reject)
            }
        })

        // Handling init errors
        tar.on('error', (err) => reject(new Error(`tar failed to init: ${err.message}`)))
        pv.on('error', (err) => reject(new Error(`pv failed to init: ${err.message}`)))
        pigz.on('error', (err) => reject(new Error(`pigz fail to init: ${err.message}`)))
    })
}

function safeBootstrapFilename(filename) {
    // Bootstrap RPC filenames are concatenated into a filesystem path, so they
    // must be a single path component (no directory traversal). Reject anything
    // with a path separator, parent ref, NUL, or that path.basename would alter.
    // Without this, "../../.." escapes /bootstrap/xchain-utxo-tracker/ and reads
    // or writes arbitrary files as root over an unauthenticated RPC.
    if (typeof filename !== 'string' || filename.length === 0 || filename.length > 255) {
        throw new Error('invalid bootstrap filename')
    }
    if (filename.includes('/') || filename.includes('\\') || filename.includes('\0')
        || filename === '.' || filename === '..'
        || filename !== path.basename(filename)) {
        throw new Error('invalid bootstrap filename: path traversal rejected')
    }
    return filename
}

async function getGzipJsonMetadata(filePath) {
    // Extract the embedded JSON metadata line from the file's leading bytes
    // WITHOUT a shell. The previous implementation interpolated `filePath` into
    // a `head | strings | grep` pipeline run via child_process.exec, so a
    // crafted filename (e.g. "$(...)" / backticks) injected shell commands:
    // remote code execution on an unauthenticated bootstrap RPC. This pure-Node
    // version reads a bounded prefix, emulates `strings` (runs of >= 4 printable
    // ASCII bytes, broken by any other byte), and returns the first run that is
    // a parseable JSON object. Contract is unchanged: resolves the metadata
    // object, or null when none is found / the file can't be read.
    const MAX_BYTES = 65 * 1024
    const MIN_RUN = 4

    let buf
    try {
        const fd = await fs.promises.open(filePath, 'r')
        try {
            const out = Buffer.alloc(MAX_BYTES)
            const { bytesRead } = await fd.read(out, 0, MAX_BYTES, 0)
            buf = out.subarray(0, bytesRead)
        } finally {
            await fd.close()
        }
    } catch (err) {
        // Missing/unreadable file: same as "no metadata found".
        return null
    }

    let start = -1
    for (let i = 0; i <= buf.length; i++) {
        const b = i < buf.length ? buf[i] : -1
        const printable = b >= 0x20 && b <= 0x7e
        if (printable) {
            if (start === -1) start = i
            continue
        }
        if (start !== -1) {
            if (i - start >= MIN_RUN
                && buf[start] === 0x7b /* { */
                && buf[i - 1] === 0x7d /* } */) {
                try {
                    return JSON.parse(buf.toString('latin1', start, i))
                } catch (parseError) {
                    // Not valid JSON: keep scanning for the next candidate run.
                }
            }
            start = -1
        }
    }
    return null
}


// List the first `limit` member paths of a (pigz/gzip) tar archive without a full
// extract: tar streams members in order, so we read the head and kill it early.
function listArchiveMembers(source, limit) {
    return new Promise((resolve, reject) => {
        const names = []
        const proc = spawn('tar', ['-tzf', source])
        let done = false
        let buf = ''
        const finish = (err) => {
            if (done) return
            done = true
            try { proc.kill('SIGKILL') } catch (e) { /* already gone */ }
            if (err) reject(err); else resolve(names)
        }
        proc.stdout.on('data', (d) => {
            buf += d.toString()
            let nl
            while ((nl = buf.indexOf('\n')) !== -1) {
                const line = buf.slice(0, nl).trim()
                buf = buf.slice(nl + 1)
                if (line) names.push(line)
                if (names.length >= limit) return finish(null)
            }
        })
        let stderr = ''
        proc.stderr.on('data', (d) => { stderr += d.toString() })
        proc.on('error', (e) => finish(e))
        proc.on('close', (code) => {
            // A short archive closes before `limit` lines: success. A nonzero exit with
            // no members means tar could not read it as a gzip tar at all.
            if (names.length > 0 || code === 0) return finish(null)
            finish(new Error(`tar could not list "${source}" (exit ${code}): ${stderr.trim()}`))
        })
    })
}

// Streaming sha256 of a file, returned as lowercase hex.
function sha256File(source) {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256')
        const rs = fs.createReadStream(source)
        rs.on('error', reject)
        rs.on('data', (chunk) => hash.update(chunk))
        rs.on('end', () => resolve(hash.digest('hex')))
    })
}

// Locate a member by basename inside an already-extracted directory tree.
function findMemberByBasename(rootDir, wantBase) {
    const stack = [rootDir]
    while (stack.length) {
        const dir = stack.pop()
        for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, ent.name)
            if (ent.isDirectory()) { stack.push(full); continue }
            if (ent.name === wantBase) return full
        }
    }
    return null
}

// Unwrap a BootstrapService two-layer wrapper archive (outer gzip tar whose members
// are `data.tar.gz` + `data.sha256`) into a temp working dir, verify the inner
// payload against its published checksum, and return the inner `data.tar.gz` path as
// the effective source for the rest of the restore pipeline. Throws (aborting with the
// live DB intact, since this runs BEFORE the /data wipe) on any extraction, layout, or
// checksum failure. The caller must remove `tmpDir` when done.
async function unwrapBootstrapArchive(source) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-restore-unwrap-'))
    try {
        const ex = spawnSync('tar', ['-xzf', source, '-C', tmpDir], { encoding: 'utf8' })
        if (ex.status !== 0)
            throw new Error(`Refusing to restore "${source}": failed to extract the wrapper archive `
                + `(tar exit ${ex.status}): ${(ex.stderr || '').trim()}`)

        const innerTarGz = findMemberByBasename(tmpDir, 'data.tar.gz')
        const innerSha   = findMemberByBasename(tmpDir, 'data.sha256')
        if (!innerTarGz || !innerSha)
            throw new Error(`Refusing to restore "${source}": wrapper archive is missing its inner `
                + `data.tar.gz and/or data.sha256 member after extraction.`)

        const expected = parseSha256Sidecar(fs.readFileSync(innerSha, 'utf8'))
        if (!expected)
            throw new Error(`Refusing to restore "${source}": inner data.sha256 has no valid sha256 digest.`)
        const actual = await sha256File(innerTarGz)
        if (actual !== expected)
            throw new Error(`Refusing to restore "${source}": inner data.tar.gz sha256 mismatch `
                + `(expected ${expected}, got ${actual}) - archive is truncated, stale, or tampered.`)
        console.log(`Wrapper archive unwrapped; inner data.tar.gz sha256 verified against data.sha256`)
        return { effectiveSource: innerTarGz, tmpDir }
    } catch (err) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {}
        throw err
    }
}

// Detached provenance signature published next to the archive, and the public key
// this repo pins as the trust anchor. Mirrors xchain-node's BootstrapService: the
// anchor travels with the CODE, not with the data server, so an attacker who controls
// the bootstrap host still cannot mint an archive this tracker will restore.
const BOOTSTRAP_SIG_SUFFIX = '.sig'
const DEFAULT_BOOTSTRAP_PUBKEY_PATH = path.join(__dirname, 'config', 'bootstrap_signing_pubkey.pem')

// Load the pinned bootstrap signing public key, or null when none is present.
function loadBootstrapPublicKey() {
    const override = process.env.UTXO_TRACKER_BOOTSTRAP_PUBKEY
    const pubkeyPath = override || DEFAULT_BOOTSTRAP_PUBKEY_PATH
    // Swapping the anchor via env silently moves the trust root off the pinned key, so
    // say so as loudly as the unsigned opt-out does; an operator reading "signature OK"
    // must know which key produced it.
    if (override && path.resolve(override) !== path.resolve(DEFAULT_BOOTSTRAP_PUBKEY_PATH))
        console.warn(`WARNING: bootstrap signature trust anchor overridden via UTXO_TRACKER_BOOTSTRAP_PUBKEY=${override}; `
            + `the repo-pinned public key (${DEFAULT_BOOTSTRAP_PUBKEY_PATH}) is NOT in use.`)
    if (!fs.existsSync(pubkeyPath)) return null
    return createPublicKey(fs.readFileSync(pubkeyPath, 'utf8'))
}

// Provenance gate, run before any checksum work and before the destructive wipe.
// Every checksum this file verifies travels WITH the archive (the sidecar beside it,
// the inner data.sha256 inside it), so anyone who can write the bootstrap volume or
// alter the archive in transit can recompute it and be self-consistent: integrity is
// not authenticity (#4426). The published archives carry `<archive>.sig`, an ed25519
// signature over the archive's sha256 digest, which xchain-node's downloadBootstrap
// fetches into the same directory. Fail closed: a missing key or missing/bad signature
// refuses the restore unless the operator sets BOOTSTRAP_RESTORE_ALLOW_UNSIGNED=1,
// which is what a locally-taken getbootstrap snapshot (unsigned, no signing key in the
// container) needs. Returns silently when the archive may be used; throws when it must
// not be.
async function verifyBootstrapProvenanceOrThrow(source) {
    const sigPath   = source + BOOTSTRAP_SIG_SUFFIX
    const publicKey = loadBootstrapPublicKey()

    if (publicKey && fs.existsSync(sigPath)) {
        const signature = parseDetachedSignature(fs.readFileSync(sigPath, 'utf8'))
        if (!signature)
            throw new Error(`Refusing to restore "${source}": signature file ${sigPath} is malformed `
                + `(expected "v1 ed25519 <base64>").`)
        const digestHex = await sha256File(source)
        if (!verifyAsymmetric(null, Buffer.from(digestHex, 'hex'), publicKey, signature))
            throw new Error(`Refusing to restore "${source}": detached signature ${sigPath} does not verify `
                + `against the pinned bootstrap signing key - the archive is not the one that was published.`)
        console.log(`Restore archive provenance verified: ${sigPath} checks out against the pinned signing key`)
        return
    }

    const missing = !publicKey
        ? `no bootstrap signing public key is pinned (${DEFAULT_BOOTSTRAP_PUBKEY_PATH})`
        : `no signature file found (${sigPath})`
    if (process.env.BOOTSTRAP_RESTORE_ALLOW_UNSIGNED !== '1')
        throw new Error(`Refusing to restore "${source}": ${missing}, so the archive's PROVENANCE cannot be `
            + `checked before the destructive /data wipe (its checksums ship with it and prove only that it is `
            + `internally consistent). Publish a .sig next to the archive, or set `
            + `BOOTSTRAP_RESTORE_ALLOW_UNSIGNED=1 to restore an unsigned archive at your own risk.`)
    console.warn(`WARNING: restoring "${source}" WITHOUT provenance verification (${missing}) because `
        + `BOOTSTRAP_RESTORE_ALLOW_UNSIGNED=1 is set; the checksum only detects transport corruption, not tampering.`)
}

// Content gate: refuse an archive that is not a LevelDB store at all. Checksums and
// signatures both say "this is the archive that was published"; neither says "this
// archive holds a store", so a correctly-signed-or-checksummed tar of unrelated files
// used to pass validation, after which the unconditional wipe deleted /data and the
// tracker reopened onto a fresh empty DB (#4368). The member list must be the FULL one:
// the limit-10 listing used for wrapper detection is far too short, since CURRENT and
// MANIFEST-* sort after the first ten members of a real store. Cost is one extra
// decompress pass of an archive the pipeline is about to decompress anyway.
async function assertLevelDbArchiveOrThrow(archivePath, reportedSource) {
    const members = await listArchiveMembers(archivePath, Infinity)
    if (!hasRequiredLevelDbMembers(members))
        throw new Error(`Refusing to restore "${reportedSource}": the archive does not contain a LevelDB store `
            + `(no CURRENT plus MANIFEST-* member), so extracting it over the wiped /data would leave the `
            + `tracker on an empty database.`)
}

// Validate a restore archive BEFORE the destructive /data wipe. Returns the effective
// source to feed the pigz/tar pipeline plus an optional temp dir the caller must clean
// up. Three gates, in trust order: provenance (a detached signature over the outer
// archive, fail-closed unless BOOTSTRAP_RESTORE_ALLOW_UNSIGNED=1, #4426), integrity
// (the BootstrapService wrapper layout is unwrapped and its inner payload
// checksum-verified in place rather than refused, #2445/#2726; a single-layer archive
// is verified against its published sha256 sidecar, #2604, with a missing sidecar
// failing closed unless BOOTSTRAP_RESTORE_ALLOW_UNVERIFIED=1, #2725), and content (the
// effective archive really is a LevelDB store, #4368).
async function validateBootstrapArchiveOrThrow(source) {
    await verifyBootstrapProvenanceOrThrow(source)

    const members = await listArchiveMembers(source, 10)
    if (isWrapperArchive(members)) {
        const unwrapped = await unwrapBootstrapArchive(source)
        try {
            await assertLevelDbArchiveOrThrow(unwrapped.effectiveSource, source)
        } catch (err) {
            // unwrapBootstrapArchive hands the temp dir to the caller once it returns, so
            // a rejection here owns the cleanup it would otherwise have done itself.
            try { fs.rmSync(unwrapped.tmpDir, { recursive: true, force: true }) } catch (_) {}
            throw err
        }
        return unwrapped
    }

    const sidecarPath = source + '.sha256'
    if (fs.existsSync(sidecarPath)) {
        const expected = parseSha256Sidecar(fs.readFileSync(sidecarPath, 'utf8'))
        if (!expected)
            throw new Error(`Refusing to restore "${source}": checksum sidecar ${sidecarPath} has no valid sha256 digest.`)
        const actual = await sha256File(source)
        if (actual !== expected)
            throw new Error(`Refusing to restore "${source}": sha256 mismatch vs ${sidecarPath} `
                + `(expected ${expected}, got ${actual}) - archive is truncated, stale, or tampered.`)
        console.log(`Restore archive sha256 verified against ${sidecarPath}`)
    } else if (process.env.BOOTSTRAP_RESTORE_ALLOW_UNVERIFIED === '1') {
        console.warn(`WARNING: no checksum sidecar at ${sidecarPath}; restoring "${source}" UNVERIFIED `
            + `(truncation/tampering cannot be detected) because BOOTSTRAP_RESTORE_ALLOW_UNVERIFIED=1 is set. `
            + `Publish a .sha256 next to the archive to restore integrity checking.`)
    } else {
        throw new Error(`Refusing to restore "${source}": no checksum sidecar at ${sidecarPath}, so the `
            + `archive cannot be verified against truncation or tampering before the destructive /data wipe. `
            + `Publish a .sha256 next to the archive, or set BOOTSTRAP_RESTORE_ALLOW_UNVERIFIED=1 to proceed `
            + `unverified at your own risk.`)
    }
    await assertLevelDbArchiveOrThrow(source, source)
    return { effectiveSource: source, tmpDir: null }
}

async function decompressPigz(taskId, source, destination) {
    // Validate BEFORE the destructive wipe: an unsigned, wrong-layout, checksum-failing,
    // or not-a-LevelDB-store archive must abort with the live DB intact, never delete
    // /data then restore a corrupt, empty, or attacker-chosen store (#2445 / #2604 /
    // #4368 / #4426). A wrapper archive is unwrapped+verified here and its
    // inner data.tar.gz becomes the effective source (#2726); tmpDir (outside /data) is
    // cleaned up after the pipeline completes.
    // Pre-wipe validation runs with the live DB still intact, so any error escaping
    // it (missing/invalid sidecar, checksum mismatch, wrapper unwrap failure) is a
    // recoverable abort, NOT the post-wipe fail-loud regime. Tag it so the caller's
    // failure handler resumes indexing instead of exiting the process (the /data
    // store was never touched). Only decompressPigzInner, below, is post-wipe.
    let effectiveSource, tmpDir
    try {
        ({ effectiveSource, tmpDir } = await validateBootstrapArchiveOrThrow(source))
    } catch (err) {
        if (err && typeof err === 'object') err.preWipe = true
        throw err
    }
    const cleanupTmp = () => { if (tmpDir) { try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {} } }
    try {
        return await decompressPigzInner(taskId, effectiveSource, destination)
    } finally {
        cleanupTmp()
    }
}

async function decompressPigzInner(taskId, source, destination) {
    console.log("Deleting data directory")
    deleteFilesInDirectorySync(destination)
    //fs.mkdirSync(destination, { recursive: true })
    console.log("Decompressing the data...")

    // Read the comment in the GZIP file
    const comment = await getGzipJsonMetadata(source)
    let totalUncompressedBytes = null
    
    if (comment) {
        try {
            totalUncompressedBytes = comment["original_size"]
        } catch(err) {
            console.warn("WARNING: Couldn't find a valid metadata in the compressed file. There will be no progress to show.")
        }
    } else {
        console.warn("WARNING: Couldn't find any metadata in the compressed file. There will be no progress to show.")
    }

    console.log(`Decompressing from "${source}" to "${destination}"...`)

    // Execute pigz -d -> pv -> tar -x
    const pigz = spawn('pigz', ['-d', '-c', source])

    const pvArgs = ['-n', '-f']
    if (totalUncompressedBytes !== null) {
        pvArgs.unshift('-s', totalUncompressedBytes.toString()) // Add -s only if the size is valid
    }
    const pv = spawn('pv', pvArgs)
    const tar = spawn('tar', ['-x', '-f', '-', '-C', destination])

    // Connect the processes
    pigz.stdout.pipe(pv.stdin)
    pv.stdout.pipe(tar.stdin)

    let lastReportedValue = -1
    pv.stderr.on('data', (data) => {
        // handling pv progress
        const percentageString = data.toString().trim(); // pv -n prints the progress and a line break
        const currentPercentage = parseInt(percentageString, 10);
        
        if (!isNaN(currentPercentage)) { // Check if the percentage is a valid number
            tasks[taskId]["progress"] = currentPercentage
        }
    })

    // Handling errors
    pigz.stderr.on('data', (data) => { console.error(`Error from pigz: ${data}`) })
    tar.stderr.on('data', (data) => { console.error(`Error from tar: ${data}`) })

    return new Promise((resolve, reject) => {
        let pigzError = null
        let pvError = null
        let tarError = null

        pigz.on('close', (code) => {
            if (code !== 0) pigzError = new Error(`pigz exited with code ${code}`)
        })
        pv.on('close', (code) => { 
            if (code !== 0) pvError = new Error(`pv exited with code ${code}`)
        })
        tar.on('close', (code) => {
            if (code !== 0) tarError = new Error(`tar exited with code ${code}`)

            if (pigzError || pvError || tarError) {
                reject(pigzError || pvError || tarError);
            } else {
                console.log(`Process completed. Dir "${destination}".`);
                resolve(destination)
            }
        })

        pigz.on('error', (err) => reject(new Error(`pigz fail to init: ${err.message}`)));
        pv.on('error', (err) => reject(new Error(`pv failed to init: ${err.message}`)));
        tar.on('error', (err) => reject(new Error(`tar failed to init: ${err.message}`)));
    })
}

function deleteFilesInDirectorySync(directoryPath) {
    try {
        const files = fs.readdirSync(directoryPath, { withFileTypes: true })

        for (const file of files) {
            const filePath = path.join(directoryPath, file.name)
            if (file.isDirectory()) {
                fs.rmSync(filePath, { recursive: true })
            } else {
                fs.rmSync(filePath)
            }
        }
    } catch (err) {
        console.log(err)
        throw new Error(`Error trying to delete the content of ${directoryPath}:`, err)
    }
}

async function isDbEmpty() {
    const store = new LevelUpStore(DB_NAME)
    try {
        await store.createDatabase()
        const h = await store.getLastBlockHeight()
        return h < 0
    } finally {
        try { await store.close() } catch (_) {}
    }
}

async function waitForNodeSynced() {
    const connector = new BlockchainConnector(NODE_URL, NODE_PORT, NODE_USER, NODE_PASSWORD)
    console.log('[bulk-sync] waiting for coin node to finish IBD...')
    for (;;) {
        try {
            const info = await connector.getBlockchainInfo()
            const lag = info.headers - info.blocks
            if (lag <= 5) {
                console.log(`[bulk-sync] node synced: blocks=${info.blocks} headers=${info.headers}`)
                return
            }
            console.log(`[bulk-sync] node lag=${lag} (blocks=${info.blocks}/headers=${info.headers})`)
        } catch (err) {
            console.log(`[bulk-sync] node not reachable yet: ${err.message}`)
        }
        await new Promise(r => setTimeout(r, BULK_SYNC_NODE_POLL_MS))
    }
}

function runBulkSyncOrchestrator() {
    const dbPath   = path.join('/data', DB_NAME)
    const orchPath = path.join(__dirname, 'bulk-sync', 'orchestrator.js')

    const args = [
        orchPath,
        '--network',    NETWORK,
        '--from',       '0',
        '--tip-safety', BULK_SYNC_TIP_SAFETY,
        '--chunk-size', BULK_SYNC_CHUNK_SIZE,
        '--workers',    BULK_SYNC_WORKERS,
        '--out',        BULK_SYNC_WORK_DIR,
        '--db',         dbPath,
        '--ram-budget', BULK_SYNC_RAM_BUDGET,
        '--batch-size', BULK_SYNC_BATCH_SIZE,
    ]

    // Resume support: if parsed/ already has worker output, skip dump+parse.
    const parsedDir = path.join(BULK_SYNC_WORK_DIR, 'parsed')
    if (fs.existsSync(parsedDir) && fs.readdirSync(parsedDir).some(f => f.endsWith('.dat'))) {
        console.log('[bulk-sync] detected existing parsed/ - adding --skip-parse')
        args.push('--skip-parse')
    }

    console.log('[bulk-sync] spawning orchestrator:', ['node', ...args].join(' '))

    return new Promise((resolve, reject) => {
        const child = spawn('node', args, { stdio: 'inherit', env: process.env })
        child.on('exit', (code) => {
            if (code === 0) resolve()
            else reject(new Error(`orchestrator exited with code ${code}`))
        })
        child.on('error', reject)
    })
}

async function runBulkSyncIfEmpty() {
    if (!(await isDbEmpty())) {
        return
    }
    console.log(`[bulk-sync] DB '${DB_NAME}' is empty, triggering bulk-sync pipeline`)
    await waitForNodeSynced()

    // bulk-sync requires at least tipSafety+1 blocks. On fresh regtest stacks
    // (or any chain that hasn't reached coinbase maturity yet) the node reports
    // headers==blocks==0: waitForNodeSynced returns immediately, then dump.js
    // FATALs with "computed dump end (tip=0 - safety=10) is before --from=0".
    // Skip the pipeline and let the normal incremental tracker handle it.
    const connector = new BlockchainConnector(NODE_URL, NODE_PORT, NODE_USER, NODE_PASSWORD)
    const info      = await connector.getBlockchainInfo()
    // The floor must match the orchestrator's actual stop point, not the raw
    // tip-safety. We always spawn it with --to unpinned, so effectiveTipSafety()
    // clamps tip-safety up to resolveUndoBlocks(network) (BTC 12 / LTC 48 /
    // DOGE 120) and dump.js stops at chainTip - max(tipSafety, undoBlocks). If
    // this pre-flight only required tipSafety+1, a chain whose tip sits in
    // [tipSafety+1, undoBlocks) would pass here, then dump.js computes a negative
    // dumpEnd and FATALs, crash-looping the tracker before startApi(). Keep the
    // two in lockstep so a too-short chain falls through to the incremental tracker.
    const minBlocks = Math.max(parseInt(BULK_SYNC_TIP_SAFETY, 10), resolveUndoBlocks(NETWORK)) + 1
    if (info.blocks < minBlocks) {
        console.log(`[bulk-sync] chain too short (${info.blocks} blocks < ${minBlocks} required): skipping bulk-sync, incremental sync will index from block 0`)
        return
    }

    await runBulkSyncOrchestrator()
    try {
        fs.rmSync(BULK_SYNC_WORK_DIR, { recursive: true, force: true })
        console.log(`[bulk-sync] work dir ${BULK_SYNC_WORK_DIR} removed after successful load`)
    } catch (err) {
        console.warn(`[bulk-sync] cleanup warning: ${err.message}`)
    }
}

// Only auto-start when run as the process entry point. When api.js is required by a
// unit test, skip the bulk-sync/startApi boot so the pure helpers below can be
// exercised in isolation.
if (require.main === module) {
    runBulkSyncIfEmpty()
        .then(() => startApi())
        .catch(err => {
            console.error('[fatal]', err.message)
            if (err.stack) console.error(err.stack)
            process.exit(1)
        })
}

module.exports = {
    deriveHealthStatus,
    isNodeRpcStale,
    deriveSyncedVerdict,
    NODE_RPC_STALE_MS,
    validateBootstrapArchiveOrThrow,
    unwrapBootstrapArchive,
    verifyBootstrapProvenanceOrThrow,
    assertLevelDbArchiveOrThrow,
    listArchiveMembers,
    sha256File,
    // Exported for the M-9 recovery regression only: the bootstrap task map and
    // the compressor that must leave a record behind for handleBootstrapFailure
    // to stamp. Nothing outside src/api.js consumes either at runtime.
    compressDirPigz,
    bootstrapTasks: tasks,
}