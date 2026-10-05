'use strict'
const jsonRouter = require('express-json-rpc-router')
const XChainUtxoTracker = require('../XChainUtxoTracker')
const { randomUUID } = require('crypto')
const { handleBootstrapFailure, handleRestoreFailure } = require('../bootstrap/bootstrap_recovery.js')
const { getLogger } = require('../observability')
const { compressDirPigz, decompressPigz, tasks } = require('./compression.js')
const { sendAddressError, safeBootstrapFilename } = require('./errors.js')
const { deriveHealthStatus, get_sync_status, registerStatusRoute } = require('./sync_status.js')
const logger = getLogger()

function registerUtxoRoute({ app, requestGate, getUtxos, parsePageOpts, setFreshnessHeaders }){
    app.get('/utxos/:address', requestGate.hold(async (req, res) => {
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
            // X-Synced:false beside X-Mempool-Ready:true on the same response.
            res.set('X-Mempool-Ready', String(freshness.mempool_ready));
            // Continuation cursor for paginated requests (?limit=). Absent when not
            // paginating or when the final page has been reached.
            if (utxos && utxos.nextCursor) res.set('X-Next-Cursor', String(utxos.nextCursor));
            res.send(utxos);
        } catch (err) {
            sendAddressError(res, err);
        }
    }))
}
function registerFirstSeenRoute({ app, requestGate, getFirstSeen, setFreshnessHeaders }){
    app.get('/firstseen/:address', requestGate.hold(async (req, res) => {
        const address = req.params.address;
        try {
            const firstSeen = await getFirstSeen(address);
            await setFreshnessHeaders(res);
            res.json(firstSeen);
        } catch (err) {
            sendAddressError(res, err);
        }
    }))
}
function registerBalanceRoute({ app, requestGate, getBalance, setFreshnessHeaders }){
    app.get('/balance/:address', requestGate.hold(async (req, res) => {
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
    }))
}
function registerInfoRoute({ app, requestGate, getInfo, setFreshnessHeaders }){
    app.get('/info/:address', requestGate.hold(async (req, res) => {
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
            // publish X-Synced:false beside X-Mempool-Ready:true.
            res.set('X-Mempool-Ready', String(freshness.mempool_ready));
            if (info && typeof info === 'object') info.mempool_ready = freshness.mempool_ready;
            if (info && typeof info === 'object') info.sync = freshness;
            res.send(info);
        } catch (err) {
            sendAddressError(res, err);
        }
    }))
}
// Readiness contract: the tracker's height fields all report the LAST
// COMMITTED state, not in-flight processing. The tracker buffers up to
// DB_TRANSACTION_BLOCKS_QUANTITY blocks before flushing via endTransaction()
// and getLastBlockHeight() reads from disk, so getLastBlockHeight() returning
// N guarantees every output in blocks 0..N is queryable via get_utxos /
// get_balance. `tracker_height` and `committed_height` are aliases for the
// last committed block; `committed_height` is canonical and `tracker_height`
// is retained for existing callers.
//
// Quiescence probe: ready=true iff the node-side mempool is empty (no unmined
// txs the tracker is blind to until the next MEMPOOL_INTERVAL poll) and the
// node tip equals the tracker's last-committed height (which is naturally
// false mid-batch). Callers poll it between e2e tests as a barrier so the next
// test starts from a fully-settled stack.
async function isQuiescent(tracker) {
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
}
// Begins a bootstrap or restore: rejects a second op while one is in flight,
// validates the filename, then pauses the tracker. stopParsing leaves the
// tracker RUNNING when the stop times out (it restores keepParsing), rejecting
// the promise, so a failed stop releases the busy flag and surfaces the error
// instead of wedging every future admin RPC while the tracker is in fact still
// indexing. Returns {error} on refusal, or {filename} once the tracker is paused.
async function beginAdminOperation({ tracker, guard, filename, what }) {
    if(guard.busy) return { error: 'a bootstrap or restore operation is already in progress' }
    try { filename = safeBootstrapFilename(filename) }
    catch (e) { return { error: e.message } }
    guard.busy = true
    try {
        await tracker.stopParsing()
    } catch (e) {
        guard.busy = false
        return { error: 'could not pause the tracker for ' + what + ': ' + (e && e.message ? e.message : e) }
    }
    return { filename }
}
function taskStatus({taskid}) {
    if (taskid in tasks){
        return tasks[taskid]
    } else {
        return {error:"taskid doesn't exist"}
    }
}
// Method table shared by every controller instance. Each method runs with
// `this` bound to one instance carrying its own request context, so two apps
// never share a tracker or a bootstrap guard. The guard serializes
// bootstrap/restore: both stopParsing() then wipe/read /data via pigz+tar, and
// two overlapping calls would run two `tar` processes into the same directory
// and corrupt the live LevelDB. stopParsing() is idempotent, so it is NOT a
// mutex; the guard flag rejects a second op while one is in flight and is
// cleared in every completion path.
const jsonRpcController = {
        async ping() {
            return {status:"success"};
        },
        async get_sync_status() {
            return get_sync_status(this.context.tracker)
        },
        // Health probe: the richest surface a consumer gates on (lag plus halt
        // markers), matching xchain-decoder's and xchain-indexer's health().
        // Delegates to get_sync_status so the lag math and SYNCED_THRESHOLD stay
        // defined in one place. xchain-node's BootstrapHealthGate probes this
        // method first and falls back to GET /status.
        async health() {
            const jsonRpcController = this;
            const sync = await jsonRpcController.get_sync_status();
            const tracker = this.context.tracker;
            // Same reachability read GET /status runs: a missing or unreachable
            // store throws here, so it reports unhealthy instead of passing a
            // bare committed_height of -1 off as a healthy empty tracker.
            let dbOk = false;
            try { await tracker.db.getLastBlockHeight(); dbOk = true; } catch (e) {}
            return { status: deriveHealthStatus({ halted: !!tracker.halted, dbOk }), db: dbOk, ...sync };
        },
        async is_quiescent() {
            return isQuiescent(this.context.tracker)
        },
        // Pages the result with optional limit/after; omitted = full set (capped by
        // the tracker's MAX_ADDRESS_OUTPUTS safety ceiling). nextCursor is returned
        // only when paginating and more rows remain. The sync field is an additive
        // freshness surface so callers can gate on committed height / lag without a
        // separate get_sync_status round-trip.
        async get_utxos({address, limit, after}) {
            const { getUtxos, parsePageOpts, getFreshnessMeta } = this.context
            let utxos = await getUtxos(address, parsePageOpts({ limit, after }))
            const result = { utxos: utxos }
            if (utxos && utxos.nextCursor) result.nextCursor = utxos.nextCursor
            result.sync = await getFreshnessMeta()
            return result
        },
        // Frozen shape: bare {height} or null. xchain-indexer's UtxoTracker client
        // parses it positionally and that verdict feeds a replay-frozen dispenser
        // path, so wrapping it (the null case included) would change historical
        // outcomes. Callers needing freshness use get_first_seen_status below or
        // the REST /firstseen/:address headers.
        async get_first_seen({address}) {
            const { getFirstSeen } = this.context
            return await getFirstSeen(address)
        },
        // Freshness-aware sibling of get_first_seen: one shape in every case, so a
        // null first_seen from a lagging, halted or unwinding tracker is
        // distinguishable from an address that has genuinely never appeared on chain.
        async get_first_seen_status({address}) {
            const { getFirstSeen, getFreshnessMeta } = this.context
            const firstSeen = await getFirstSeen(address)
            return { first_seen: firstSeen || null, sync: await getFreshnessMeta() }
        },
        async get_balance({address}) {
            const { getBalance, getFreshnessMeta } = this.context
            let balance = await getBalance(address)
            return { balance: balance, sync: await getFreshnessMeta() }
        },
        async get_info({address}) {
            const { getInfo, getFreshnessMeta } = this.context
            const info = await getInfo(address)
            if (info && typeof info === 'object') info.sync = await getFreshnessMeta()
            return info
        },
        // Exact full-txid to block lookup, frozen shape: {block_hash, block_height,
        // sync} or null for a well-formed but unknown/unindexed/rolled-back txid,
        // matching get_first_seen's bare-value contract. A malformed txid is the
        // one case that returns {error}, since that is a caller mistake rather than
        // "not found".
        async get_tx_block({txid}) {
            if (typeof txid !== 'string' || !/^[0-9a-fA-F]{64}$/.test(txid)) {
                return { error: "txid must be a 64-hex-character string" }
            }
            return await this.context.tracker.db.getTxBlock(txid)
        },
        // Buffer.from(str, 'hex') silently truncates at the first non-hex
        // character, so e.g. 32 'g's would decode to an EMPTY prefix and scan the
        // entire database; non-hex is rejected before it decodes. maxValues caps
        // the scan the same way MAX_ADDRESS_OUTPUTS bounds unbounded address
        // queries: fail loud instead of OOMing.
        async get_input_from_key_pattern({pattern}) {
            if (typeof pattern !== 'string' || pattern.length < 32){
                return {error: "pattern is too short"}
            } else if (!/^[0-9a-fA-F]+$/.test(pattern)){
                return {error: "pattern must be a hex string"}
            } else {
                let results = await this.context.tracker.db.getValuesFromKeyPattern(pattern,
                    { maxValues: XChainUtxoTracker.MAX_ADDRESS_OUTPUTS })
                return { result: results}
            }
        },
        async getbootstrap({filename}){
            logger.info("A bootstrap was requested")
            const { tracker, DB_NAME, launchTracker } = this.context
            const guard = this.bootstrapGuard
            const begun = await beginAdminOperation({ tracker, guard, filename, what: 'bootstrap' })
            if (begun.error) return begun
            filename = begun.filename
            let taskId = randomUUID()
            try {
                logger.info("Compressing the data...")
                let destination = "/bootstrap/xchain-utxo-tracker/"+filename
                tasks[taskId] = {"progress": 0, "filename": filename}
                compressDirPigz(taskId, "/data/"+DB_NAME, destination).then((finished) =>{
                    tasks[taskId]["progress"] = 100
                    logger.info("Starting the parsing again")
                    guard.busy = false
                    launchTracker(tracker)
                }).catch(error => {
                    // Compression failed but /data is untouched: resume indexing so a
                    // failed snapshot never freezes the tracker, and keep the task
                    // record so a status poll surfaces the failure.
                    guard.busy = false
                    handleBootstrapFailure({ tasks, taskId, error, relaunch: () => launchTracker(tracker) })
                })
                return {"task_id":taskId}
            } catch (err){
                logger.info("Warning compression was not succesful: "+err)
                guard.busy = false
                delete tasks[taskId]
                return {error: err}
            }
        },
        async getbootstrapstatus(params){
            return taskStatus(params)
        },
        // The extraction replaced the store the halt was declared against, so the
        // marker no longer describes what is on disk. Without clearing it the one
        // tracker instance this process ever builds keeps reporting halted=true and
        // 503 after a successful resync, and xchain-node's bootstrap gate refuses it
        // forever. Only the restore path clears it: getbootstrap leaves the data
        // untouched, so a halt there is still true. There is no RPC to clear a
        // marker in place because the only recovery that changes the data is this
        // restore or `xchain-node reset`.
        //
        // decompressPigz wipes /data BEFORE extracting, so a POST-wipe failure leaves
        // the on-disk DB partially wiped and untrustworthy: fail loud so the
        // supervisor restarts into a clean recovery path. A PRE-wipe validation
        // abort (error.preWipe) never touched /data, so handleRestoreFailure resumes
        // indexing via relaunch instead of killing the process.
        async restorebootstrap({filename}){
            logger.info("A bootstrap restore was requested")
            const { tracker, DB_NAME, launchTracker } = this.context
            const guard = this.bootstrapGuard
            const begun = await beginAdminOperation({ tracker, guard, filename, what: 'restore' })
            if (begun.error) return begun
            filename = begun.filename
            let taskId = randomUUID()
            try {
                let source = "/bootstrap/xchain-utxo-tracker/"+filename
                tasks[taskId] = {"progress": 0, "filename": filename}
                decompressPigz(taskId, source, "/data/"+DB_NAME).then((finished) =>{
                    tasks[taskId]["progress"] = 100
                    logger.info("Starting the parsing")
                    guard.busy = false
                    tracker.clearHalt()
                    launchTracker(tracker)
                }).catch(error => {
                    guard.busy = false
                    handleRestoreFailure({ tasks, taskId, error,
                        failLoud: () => process.exit(1),
                        relaunch: () => launchTracker(tracker) })
                })
                return {"task_id":taskId}
            } catch (err){
                logger.info("Warning decompression was not succesful: "+err)
                guard.busy = false
                delete tasks[taskId]
                return {error: err}
            }
        },
        async getbootstraprestorestatus(params){
            return taskStatus(params)
        }
}
function createJsonRpcController(context) {
    const instance = {}
    Object.defineProperty(instance, 'context', { value: context })
    Object.defineProperty(instance, 'bootstrapGuard', { value: { busy: false } })
    for (const [name, method] of Object.entries(jsonRpcController)) {
        instance[name] = method.bind(instance)
    }
    return instance
}
function registerRoutes(context){
    const { app, tracker, probeGate, requestGate, getFreshnessMeta } = context
    registerUtxoRoute(context)
    registerFirstSeenRoute(context)
    registerBalanceRoute(context)
    registerInfoRoute(context)
    registerStatusRoute({ app, tracker, probeGate, requestGate, getFreshnessMeta })
    // Express 5 / body-parser 2.x leaves req.body undefined when a request carries
    // no JSON body (a GET, or a POST without application/json), whereas body-parser
    // 1.x set it to {}. express-json-rpc-router requires req.body to be an object or
    // it throws ("req.body is required"). Restore the {} default so unmatched requests
    // that fall through to this root-mounted router get a normal JSON-RPC error
    // response instead of crashing the request.
    app.use((req, res, next) => { if (req.body === undefined) req.body = {}; next(); });
    // One wrap covers every JSON-RPC method, batches included. The router does
    // NOT await a batch entry without an id (a notification), so its promise can
    // settle while that entry's read still runs. trackMethods() registers each
    // method's promise with the gate, and hold() keeps the slot until all of
    // them settle. The internal get_sync_status() call above still goes through
    // the bare controller object, so an in-process call never touches gate accounting.
    const jsonRpcController = createJsonRpcController(context)
    const methods = context.jsonRpcMethods
        ? Object.assign({}, jsonRpcController, context.jsonRpcMethods)
        : jsonRpcController
    app.use(requestGate.hold(jsonRouter({methods: requestGate.trackMethods(methods)})))
}
module.exports = { registerRoutes }
