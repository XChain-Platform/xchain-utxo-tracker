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

// Before anything else logs. The UTXO_TRACKER_API_KEY notice immediately below
// is exactly the line an operator needs levelled and timestamped, and
// installObservability does not run until ~390 lines further down.
const { patchConsole } = require('./observability');
patchConsole({
    service: 'xchain-utxo-tracker',
    version: require('../package.json').version,
    coin:    process.env.COIN || '',
    network: process.env.NETWORK || ''
});

const { spawn } = require('child_process');
const LevelUpStore = require('./store/level_up_db.js')
const fs = require('fs')
const XChainUtxoTracker  = require('./XChainUtxoTracker');
const BlockchainConnector = require('./chain/blockchain_connector');
const { resolveUndoBlocks } = require('./bulk-sync/merger/derive_keys.js')
const memoryBudget = require('./store/memory_budget')
const { installCrashHandlers, noteCrash } = require('./server/crash_handlers.js')
const { envInt: sharedEnvInt } = require('./config/env_int')
const { timingSafeEqual } = require('crypto')
const path = require('path')
const { startApi } = require('./api/startup.js')
const syncStatus = require('./api/sync_status.js')
const {
    deriveHealthStatus, isNodeRpcStale, nodeReachabilityFields,
    deriveSyncedVerdict, configureNodeRpcStaleMs
} = syncStatus
const apiErrors = require('./api/errors.js')
const {
    validateBootstrapArchiveOrThrow, unwrapBootstrapArchive,
    verifyBootstrapProvenanceOrThrow, assertLevelDbArchiveOrThrow,
    assertExtractedStoreOrThrow, listArchiveMembers, sha256File,
    configureRestoreOptions
} = apiErrors
const { compressDirPigz, tasks } = require('./api/compression.js')

const NETWORK = process.env.NETWORK
const NODE_URL =  process.env.NODE_URL
const NODE_PORT =  process.env.NODE_PORT
const NODE_USER =  process.env.NODE_USER
const NODE_PASSWORD =  process.env.NODE_PASSWORD
const UTXO_TRACKER_API_PORT = process.env.UTXO_TRACKER_API_PORT
const DB_NAME =  "xchain-utxo-tracker"
const AUX_POW = process.env.AUX_POW === 'true' || process.env.AUX_POW === '1'
const NODE_RPC_STALE_MS = parseInt(process.env.UTXO_TRACKER_NODE_RPC_STALE_MS, 10) || 150000

configureNodeRpcStaleMs(NODE_RPC_STALE_MS)
configureRestoreOptions(() => ({
    bootstrapPubkey: process.env.UTXO_TRACKER_BOOTSTRAP_PUBKEY,
    allowUnsigned: process.env.BOOTSTRAP_RESTORE_ALLOW_UNSIGNED,
    allowUnverified: process.env.BOOTSTRAP_RESTORE_ALLOW_UNVERIFIED
}))

// API key for admin JSON-RPC methods (DB bootstrap snapshot/restore and raw
// key scans). These methods fail closed (401) when no key is configured;
// read-only UTXO/balance queries stay open for the encoder/indexer.
const UTXO_TRACKER_API_KEY = process.env.UTXO_TRACKER_API_KEY || ''

// Platform-wide no-API-key posture: running keyless is allowed, but the
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

// Validate-or-fall-back resolver for the bulk-sync numeric env knobs. The reader
// itself now lives in src/config/env_int.js and is the SAME function resolveUndoBlocks
// (undo-blocks.js) and resolveCoinbaseMaturity call, so the parity is true by
// construction rather than by hand-copy; before that extraction those two sites
// were still on parseInt while this comment asserted otherwise.
// Number() rather than parseInt() because parseInt happily truncates '10abc' to 10
// and reads a typo as intent; a knob this pipeline FATALs on deserves the strict
// read. This wrapper adds only the bulk-sync sentence on the warning line.
//
// These values are not just forwarded. BULK_SYNC_TIP_SAFETY also feeds the
// too-short-chain pre-flight in runBulkSyncIfEmpty, and a raw string ran through
// parseInt there yielded NaN on a typo'd value; Math.max(NaN, undoBlocks) is NaN and
// every comparison against NaN is false, so the pre-flight that exists to fall back
// to incremental sync silently passed instead. The orchestrator was then spawned with
// --tip-safety <garbage>, which dump.js validateArgs rejects as a FATAL: one typo
// turned into a crash-loop where the design called for a graceful fallback. The
// sibling knobs go through here too because orchestrator.js parseArgs runs bare
// parseInt on all five, so a malformed --workers or --ram-budget degrades silently
// rather than failing at all.
//
// Warn-and-default rather than throw: the pre-flight's whole purpose is that a
// misconfigured tracker still comes up on the incremental path.
function envInt(name, fallback, min){
    return sharedEnvInt(name, fallback, min, 'Bulk-sync will run with the default for this knob.')
}

// Bulk-sync pre-flight (activates on empty DB). See runBulkSyncIfEmpty below.
const BULK_SYNC_WORKERS      = envInt('BULK_SYNC_WORKERS',    6,     1)
const BULK_SYNC_CHUNK_SIZE   = envInt('BULK_SYNC_CHUNK_SIZE', 10000, 1)
// Default DERIVED from the same cgroup-aware budget as the block cache and the
// flush threshold, not a flat 4096: the orchestrator is a child process, and a
// tracker capped at 2 GB was handing its sort twice the whole cgroup and being
// OOM-killed at the merge, repeatedly, on the recovery path an operator reaches
// only after something else already went wrong. An explicit env value still wins.
const BULK_SYNC_RAM_BUDGET   = envInt('BULK_SYNC_RAM_BUDGET', memoryBudget.bulkSyncRamBudgetMB(), 1)
const BULK_SYNC_TIP_SAFETY   = envInt('BULK_SYNC_TIP_SAFETY', 10,    0)
const BULK_SYNC_BATCH_SIZE   = envInt('BULK_SYNC_BATCH_SIZE', 10000, 1)
const BULK_SYNC_WORK_DIR     = process.env.BULK_SYNC_WORK_DIR     || path.join('/data', DB_NAME, '_bulk-sync-work')
const BULK_SYNC_NODE_POLL_MS = 30000

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
// Returns the settled promise so the SIGTERM drain can wait for the loop to
// break at a block boundary; a halt resolves it too (the process stays up).
// The halt writes its marker to the store before this settles, so a SIGTERM
// that follows the halt cannot cut the write short. A store already carrying
// the marker never reaches this guard: start() resolves into the halted state.
function launchTracker(tracker){
    return tracker.start().catch(async (err) => {
        try { if (tracker.db && tracker.db.endTransaction) tracker.db.endTransaction(false) } catch (_) {}
        if (XChainUtxoTracker.isUnrecoverableReorg(err)) {
            await tracker.haltForResync(err && err.message)
            return
        }
        noteCrash('pollingLoopTerminated', err)
        process.exit(1)
    })
}

// Bounds the `route` label of the HTTP metrics: the observability shim labels an
// unmatched request by its first path segment, so caller-invented paths mint one
// series each and fill the per-metric cap, dropping real routes from the scrape.
const UNMATCHED_ROUTE_LABEL = '/*unmatched';

// Mounts FIRST, ahead of every layer that can shed a request, so a shed request
// is labelled too; a specific route later in the stack overwrites the label, and
// bare `/` matches no wildcard segment and keeps its own single series.
function installUnmatchedRouteLabel(app){
    app.all(UNMATCHED_ROUTE_LABEL, (req, res, next) => next());
    return app;
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

    // String() because the knobs above are resolved NUMBERS now and spawn refuses a
    // non-string argv element; the values themselves are already validated integers,
    // so the orchestrator can no longer be handed a NaN it would FATAL on.
    const args = [
        orchPath,
        '--network',    NETWORK,
        '--from',       '0',
        '--tip-safety', String(BULK_SYNC_TIP_SAFETY),
        '--chunk-size', String(BULK_SYNC_CHUNK_SIZE),
        '--workers',    String(BULK_SYNC_WORKERS),
        '--out',        BULK_SYNC_WORK_DIR,
        '--db',         dbPath,
        '--ram-budget', String(BULK_SYNC_RAM_BUDGET),
        '--batch-size', String(BULK_SYNC_BATCH_SIZE),
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
    // clamps tip-safety up to resolveUndoBlocks(network) (BTC 12 / LTC 120 /
    // DOGE 120) and dump.js stops at chainTip - max(tipSafety, undoBlocks). If
    // this pre-flight only required tipSafety+1, a chain whose tip sits in
    // [tipSafety+1, undoBlocks) would pass here, then dump.js computes a negative
    // dumpEnd and FATALs, crash-looping the tracker before startApi(). Keep the
    // two in lockstep so a too-short chain falls through to the incremental tracker.
    // BULK_SYNC_TIP_SAFETY is already a validated integer (envInt above): the old
    // parseInt here turned a malformed env into NaN, and NaN loses every comparison,
    // so this guard silently stopped guarding on exactly the misconfiguration it
    // needed to catch.
    const minBlocks = Math.max(BULK_SYNC_TIP_SAFETY, resolveUndoBlocks(NETWORK)) + 1
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
    // Ahead of the bulk-sync boot, so a throw anywhere in it is a CRASH record
    // rather than node's bare stderr dump.
    installCrashHandlers()
    runBulkSyncIfEmpty()
        .then(() => startApi({
            NETWORK, NODE_URL, NODE_PORT, NODE_USER, NODE_PASSWORD, DB_NAME, AUX_POW,
            UTXO_TRACKER_API_PORT, UTXO_TRACKER_API_KEY, ADMIN_METHODS,
            MAX_JSONRPC_BATCH, MAX_PAGE_LIMIT, BULK_SYNC_RAM_BUDGET,
            CORS_ORIGIN: process.env.CORS_ORIGIN,
            UTXO_TRACKER_RATE_LIMIT_RPM: process.env.UTXO_TRACKER_RATE_LIMIT_RPM,
            UTXO_TRACKER_MAX_CONCURRENT_PROBES: process.env.UTXO_TRACKER_MAX_CONCURRENT_PROBES,
            UTXO_TRACKER_MAX_CONCURRENT_REQUESTS: process.env.UTXO_TRACKER_MAX_CONCURRENT_REQUESTS,
            COIN: process.env.COIN,
            keyEquals, launchTracker, installUnmatchedRouteLabel
        }))
        .catch(err => {
            noteCrash('bootFailed', err)
            process.exit(1)
        })
}

module.exports = {
    deriveHealthStatus,
    isNodeRpcStale,
    nodeReachabilityFields,
    deriveSyncedVerdict,
    NODE_RPC_STALE_MS,
    validateBootstrapArchiveOrThrow,
    unwrapBootstrapArchive,
    verifyBootstrapProvenanceOrThrow,
    assertLevelDbArchiveOrThrow,
    assertExtractedStoreOrThrow,
    listArchiveMembers,
    sha256File,
    envInt,
    installUnmatchedRouteLabel,
    UNMATCHED_ROUTE_LABEL,
    // Exported for the recovery regression test only: the bootstrap task map and
    // the compressor that must leave a record behind for handleBootstrapFailure
    // to stamp. Nothing outside src/api.js consumes either at runtime.
    compressDirPigz,
    bootstrapTasks: tasks,
}
