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

const { spawn } = require('child_process');
const LevelUpStore = require('./LevelUpDb.js')
const fs = require('fs')
const express = require('express');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const cors = require('cors');
const XChainUtxoTracker  = require('./XChainUtxoTracker');
const BlockchainConnector = require('./BlockchainConnector');
const { resolveUndoBlocks } = require('./bulk-sync/merger/derive-keys.js')
const { handleBootstrapFailure, handleRestoreFailure } = require('./bootstrap-recovery.js')
const jsonRouter = require('express-json-rpc-router')
const { randomUUID, timingSafeEqual } = require('crypto')
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

// Launch the tracker polling loop with the top-level guard. start() is intentionally not
// awaited (the Express server must come up alongside it), so without this .catch() any
// throw out of the loop (a malformed-block decode, a verifyReorg fail-stop, a transient
// DB I/O fault) becomes a bare unhandledRejection: no clean rollback and an unclear log.
// Roll back any open LevelDB batch and exit non-zero so the orchestrator restarts cleanly
// with the reason in the logs. A persistent fatal (e.g. reorg depth exceeds the recovery
// window) intentionally keeps failing here, loudly, until an operator resyncs. Used at
// EVERY start() site (primary boot + bootstrap/restore restarts) so none can regress to a
// bare unhandledRejection that skips the rollback + [fatal] log.
function launchTracker(tracker){
    tracker.start().catch((err) => {
        console.error('[fatal] UTXO tracker polling loop terminated: ' + (err && err.message), err)
        try { if (tracker.db && tracker.db.endTransaction) tracker.db.endTransaction(false) } catch (_) {}
        process.exit(1)
    })
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
    async function getFreshnessMeta(){
        let committedHeight = -1;
        try { committedHeight = await tracker.db.getLastBlockHeight(); } catch (e) {}
        const rawTip = (typeof tracker.latestKnownChainTip === 'number')
            ? tracker.latestKnownChainTip
            : (typeof tracker.blockchainInfoLastBlock === 'number' ? tracker.blockchainInfoLastBlock : -1);
        return XChainUtxoTracker.computeFreshness(committedHeight, rawTip, tracker.isSynced());
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

    // CORS disabled by default; set CORS_ORIGIN to allow a specific origin
    app.use(cors({ origin: process.env.CORS_ORIGIN || false }));

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
            // Signal mempool readiness so callers can distinguish a genuinely empty
            // result from one served before the in-memory mempool has reconverged
            // after a restart. Body shape (a bare array) is left unchanged.
            res.set('X-Mempool-Ready', String(tracker.isSynced() && tracker.isMempoolReconverged()));
            // Freshness surface: tip height / sync lag so callers can gate on
            // how stale this committed view is (see setFreshnessHeaders).
            await setFreshnessHeaders(res);
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
            // See /utxos above: expose mempool readiness via header without altering
            // the existing bare-number body.
            res.set('X-Mempool-Ready', String(tracker.isSynced() && tracker.isMempoolReconverged()));
            await setFreshnessHeaders(res);
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
            const mempoolReady = tracker.isSynced() && tracker.isMempoolReconverged();
            res.set('X-Mempool-Ready', String(mempoolReady));
            if (info && typeof info === 'object') info.mempool_ready = mempoolReady;
            // Freshness surface, both as headers and (since the body is already a
            // JSON object) an additive `sync` field callers can gate on.
            const freshness = await setFreshnessHeaders(res);
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
                // SYNCED_THRESHOLD so callers don't replicate the threshold.
                // null lag (nothing indexed yet) is never "synced". A stale node height
                // (RPC down, lag computed against a frozen cached tip) is also never
                // "synced": the live chain may have advanced far past the cached tip, so a
                // monitor keying on synced/lag must not read a frozen lag:0 as caught-up.
                synced:           !nodeHeightStale && lag !== null && lag <= XChainUtxoTracker.SYNCED_THRESHOLD
            };
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
            return result;
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
            try { filename = safeBootstrapFilename(filename) }
            catch (e) { return { error: e.message } }
            let taskId = randomUUID()
            await tracker.stopParsing()
            try {
                console.log("Compressing the data...")
                let destination = "/bootstrap/xchain-utxo-tracker/"+filename
                tasks[taskId] = {"progress": 0, "filename": filename}//, last_block_index":}
                compressDirPigz(taskId, "/data/"+DB_NAME, destination).then((finished) =>{
                    tasks[taskId]["progress"] = 100
                    console.log("Starting the parsing again")
                    launchTracker(tracker)
                }).catch(error => {
                    // Compression failed but /data is untouched: resume indexing so a
                    // failed snapshot never freezes the tracker, and keep the task
                    // record so a status poll surfaces the failure (M-9).
                    handleBootstrapFailure({ tasks, taskId, error, relaunch: () => launchTracker(tracker) })
                })

                return {"task_id":taskId}
            } catch (err){
                console.log("Warning compression was not succesful: "+err)
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
            try { filename = safeBootstrapFilename(filename) }
            catch (e) { return { error: e.message } }
            let taskId = randomUUID()
            await tracker.stopParsing()
            try {
                let source = "/bootstrap/xchain-utxo-tracker/"+filename
                tasks[taskId] = {"progress": 0, "filename": filename}
                decompressPigz(taskId, source, "/data/"+DB_NAME).then((finished) =>{
                    tasks[taskId]["progress"] = 100
                    console.log("Starting the parsing")
                    launchTracker(tracker)
                }).catch(error => {
                    // decompressPigz wipes /data BEFORE extracting, so a mid-restore
                    // failure leaves the on-disk DB partially wiped and untrustworthy.
                    // Do NOT silently resume indexing on a corrupt store: fail loud so
                    // the supervisor restarts into a clean recovery path (M-9).
                    handleRestoreFailure({ tasks, taskId, error, failLoud: () => process.exit(1) })
                })

                return {"task_id":taskId}
            } catch (err){
                console.log("Warning decompression was not succesful: "+err)
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
        const status = dbOk ? 'ok' : 'degraded'
        if (!dbOk) res.status(503)
        res.json({ status, db: dbOk, committed_height: committedHeight })
    })

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
        console.error(`Error: Invalid size for source '${source}'.`)
        delete tasks[taskId]
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
                resolve(destination)
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


async function decompressPigz(taskId, source, destination) {
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

runBulkSyncIfEmpty()
    .then(() => startApi())
    .catch(err => {
        console.error('[fatal]', err.message)
        if (err.stack) console.error(err.stack)
        process.exit(1)
    })