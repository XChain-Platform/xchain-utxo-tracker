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
 * XChain UTXO Tracker - UTXO Tracker Class
 *
 ********************************************************************/

// Load required libraries
const util = require('./common/util')
const config = require('./config')
const coins = require('./coins')
const { assertBigIntBufferutils } = require('./chain/assert_bigint_bufferutils')
// Node's own util, under a second name: `util` above is this repo's helper
// module, and the logger folds a variadic console line through format().
const nodeUtil = require('node:util')
const crypto = require('crypto');
const bs58check = require('bs58check')
const bitcoin = require('bitcoinjs-lib')
const ecc = require('tiny-secp256k1')
const fs = require('fs')
const LevelUpStore = require('./store/level_up_db.js')
const BlockchainConnector = require('./chain/blockchain_connector.js')
const CryptoNetworks = require('./chain/crypto_networks')
const XChainBlockDecoder = require('./chain/XChainBlockDecoder')
const { hrtime } = require('node:process');

// bitcoinjs-lib v6 needs an ECC backend registered before it can parse/validate
// Taproot (P2TR, witness v1) addresses. Without this, payments.p2tr() throws
// "No ECC Library provided" and getAddressType() silently classified every
// taproot address as 'unknown' (and any taproot balance/UTXO query mislabelled
// its outputs). Register once at module load.
bitcoin.initEccLib(ecc)

const PARSE_MODE_FILES = 0
const PARSE_MODE_BULK_INSERTS = 1

// Per-chain reorg recovery window (Tier B, 2026-06-02): how many recent blocks of
// spent-output recovery records (K/M entries) are retained, and therefore the
// deepest reorg the tracker can auto-recover from before a manual resync is
// required. Sized larger on the faster / lower-hashpower chains so the window
// stays comfortably above that chain's cross-chain confirmation gate (an ordinary
// reorg inside the trust window is auto-recovered, never a manual resync). On
// 1-minute DOGE blocks the old flat value of 10 was only ~10 minutes of headroom.
// Single-sourced in undo-blocks.js so the live worker and the bulk seeder can never drift.
// Import the RESOLVER only, never the table or the MAX_SAFE_UNDO_BLOCKS ceiling: this
// worker consults neither, and naming them here reads as a second clamp that does not
// exist. Both live inside resolveUndoBlocks, which is the one place they may live.
const { coinFromNetwork, resolveUndoBlocks } = require('./chain/undo_blocks.js')

// Per-coin/network coinbase maturity, resolved the same way and for the same
// reason as the reorg window above. Import the RESOLVER only, never the table:
// the flat module-level constant that stood here asserted 100 for every chain,
// which is wrong for DOGE (240 at the tip), and a second copy of the numbers in
// this file is how that drifts back.
const { resolveCoinbaseMaturity } = require('./chain/coinbase_maturity.js')

// Per-coin block/tx wire-serialization family from the canonical coin registry
// (src/coins). Used to gate AuxPoW stripping on the coin's declared wireFormat
// ('auxpow') instead of a coin-name literal.
const { WIRE_FORMAT } = require('./coins')

const { CHECK_BLOCK_DELAY_MS, BLOCKCHAIN_INFO_REFRESH_MS, DB_TRANSACTION_BLOCKS_QUANTITY, HEAP_FLUSH_THRESHOLD_MB, SYNCED_THRESHOLD, DEBUG_TRACE, MEMPOOL_INTERVAL, BLOCK_FETCH_RETRY_SLEEP_MS, REMOVE_SPENT, ETA_WINDOW_BLOCKS, MIN_VERIFICATION_PROGRESS_TO_PARSE, logger, PREFETCH_SIZE, P_PENDING_CLEANUP_KEY, MAX_ADDRESS_OUTPUTS, MAX_BLOCK_FETCH_RETRIES, AUXPOW_REASSEMBLE_AFTER } = require('./XChainUtxoTracker/constants.js')
const { satoshiToDecimalString, nodeStillCatchingUp, catchUpWaitState } = require('./XChainUtxoTracker/catch_up_helpers.js')

class XChainUtxoTracker {
    static parseOutBuckets = { hash: 0, ins: 0, sb: 0 }

    constructor(network, nodeUrl, nodePort, nodeUser, nodePassword, dbName, auxPow) {
      this.network = CryptoNetworks.getBitcoinJsNetwork(network)
      // An unrecognized coin/network name (a typo in the NETWORK env var) now
      // throws inside getBitcoinJsNetwork itself (item 5879), so this guard is no
      // longer what catches it. Kept as the backstop for the other route to the
      // same hazard: a coin the registry resolves whose config carries no `net`
      // object. bitcoinjs-lib silently defaults an undefined network to BTC
      // mainnet at address/script decode time, so either way construction must
      // fail rather than run under the wrong network parameters.
      // getBitcoinJsNetwork returns undefined for an unrecognized coin/network
      // name (e.g. a typo in the NETWORK env var). Left unguarded, bitcoinjs-lib
      // silently defaults an undefined network to BTC mainnet at address/script
      // decode time, so a misconfiguration would run under the wrong network
      // parameters instead of failing. Fail loud at construction instead.
      if (!this.network) {
        throw new Error(`XChainUtxoTracker: unknown network "${network}" -- no bitcoinjs network config resolved. Check the configured network name.`)
      }

      // Net portion ('mainnet'|'testnet'|'regtest') of the "<fullname>-<network>"
      // key. The guard above already rejected an unknown key, so the suffix here
      // is a valid network name.
      this.consensusNetwork = String(network).slice(String(network).lastIndexOf('-') + 1)

      // Verify the bundled canonical coin files against CONSENSUS_CONFIG_PIN before
      // any consensus-relevant field is read, matching decoder, indexer and hub. A
      // null pin (mainnet, pre-arm) skips; a mismatch on an armed network throws, so
      // a drifted or partially re-vendored bundle halts instead of fetching and
      // stripping block bytes under divergent network params (the auxPow decision
      // below, and the address/script rules the UTXO set is keyed on, both come from
      // this registry). Deliberately not wrapped in try/catch, and deliberately in
      // the constructor rather than start(): api.js does not await start(), so a
      // later check would let the HTTP surface bind and serve queries first.
      coins.verifyConsensusPin(this.consensusNetwork)

      this.connector = new BlockchainConnector(nodeUrl, nodePort, nodeUser, nodePassword)
      this.dbName = dbName
      
      this.db = null
      this.mempoolDb = null
      
      this.parseMode = PARSE_MODE_BULK_INSERTS
      this.xchainBlockDecoder = new XChainBlockDecoder(network)

      // Prove the BigInt-safe bufferutils patch actually took before any block is
      // decoded, matching the decoder's boot check. In the constructor for the same
      // reason as verifyConsensusPin above: api.js does not await start(), so a
      // check there would let the HTTP surface bind and serve first. Runs after the
      // decoder construction that requires the patch module.
      assertBigIntBufferutils(this.xchainBlockDecoder.coin, 'utxo-tracker')

      this.debugTime = {}
      
      this.synced = false
      // True only after the first successful mempool reconverge following a
      // synced=true transition. synced flips true at block-sync before the first
      // (unawaited) updateMempool() populates the in-memory mempool DB, so on a
      // restart the mempool is briefly empty while synced already reads true.
      // Readiness must gate on both so callers never see a synced-but-empty mempool.
      this.mempoolReconverged = false
      
      this.blockchainInfoLastBlock = -1
      this.latestKnownChainTip = null
      this.mempoolInterval = null
      this.mempoolBusy = false
      
      // AuxPoW stripping is keyed on coin identity ALONE, never on the caller's
      // env-driven flag, in BOTH directions: a Dogecoin deployment started without
      // AUX_POW=true would otherwise parse every DOGE block as a plain Bitcoin
      // block, and a BTC/LTC deployment started WITH it would strip a section those
      // chains never carry, truncating any block whose version signals bit 0x100.
      // The answer comes from the coin's declared wireFormat in the canonical
      // registry (src/coins), matching the decoder and the bulk seeder
      // (bulk-sync/dump.js). coinFromNetwork resolves the tick through that same
      // registry (item 5803): it was a hardcoded coin-name list until then, so a
      // chain onboarded by registry edit alone resolved to null here and read as
      // NOT merge-mined. The remaining per-chain value that is not in src/coins is
      // the reorg window on the next line, and resolveUndoBlocks now refuses a
      // registered coin that has none rather than defaulting it. LTC's MWEB
      // handling is unaffected: that is the
      // 'mweb' wireFormat branch inside XChainBlockDecoder, not this fetch path. The
      // `auxPow` parameter is retained for call-site stability and is deliberately no
      // longer consulted.
      this.auxPow = WIRE_FORMAT[coinFromNetwork(network)] === 'auxpow'
      this.undoBlocks = resolveUndoBlocks(network)
      this.lastBlocks = []

      // Deepest undo window this store has held, clamped to the live undoBlocks
      // (see Q_UNDO_WATERMARK_KEY). 0 means "not known yet": a store written
      // before this key existed, or one that has never committed a block. It is
      // loaded in start() and maintained by addToLastBlocks; a value on disk that
      // exceeds the live undoBlocks (the operator LOWERED the window) is clamped
      // on load, so lowering then raising the override does not read as a
      // rollback of the difference. `Persisted` tracks what disk holds so the
      // clamp is written back on the next block rather than only in memory.
      this.undoWindowWatermark = 0
      this.undoWindowWatermarkPersisted = null
      
      this.keepParsing = true
      this.pendingKMCleanup = []

      // Lifetime counters for mempool RPC failures. Surfaced in get_sync_status
      // so operators can detect a node degraded on mempool fetches without
      // needing to watch the console for the "Giving up" warning.
      this.mempoolRpcFailures = 0
      this.lastMempoolErrorAt = null

      // Lifetime reorg counters. Surfaced in get_sync_status so operators can
      // detect chains that reorg frequently and know how deep the last one was.
      this.reorgCount = 0
      this.lastReorgDepth = 0

      // Forward-progress heartbeat, stamped when a block batch is committed.
      // Kept in memory because the /metrics collector runs synchronously and so
      // cannot await the durable pointer (db.getLastBlockHeight()); see
      // src/utxoTrackerMetrics.js. Null until the first commit, which is what
      // keeps a still-starting tracker out of the stall alert. A rollback moves
      // the durable pointer without stamping these, so the height is corrected
      // at the next forward commit; reorgCount/lastReorgDepth are the signals
      // for that window.
      this.lastCommitAt = null
      this.lastCommittedHeight = null

      // Unrecoverable block-fetch desync signal. Set just before the
      // polling loop fails loud on a node that can no longer serve the next
      // block (pruned past our cursor, or a permanent missing-block fault), so
      // get_sync_status / an operator can name the fault instead of watching a
      // silent 3s retry spin. Null until such a fault is detected.
      this.blockFetchDesync = null

      // Halted state: set when an unrecoverable reorg (rolled back past the
      // UNDO_BLOCKS recovery window, or an empty in-memory last-blocks window)
      // is hit. Unlike blockFetchDesync this is NOT a "fail loud then exit for a
      // supervised restart" signal: a restart re-hits the same on-disk stale tip
      // and loops forever under Docker's unless-stopped policy. When set, the
      // process stays up but stops polling; /status returns 503 and
      // get_sync_status reports it, so an operator can resync (restorebootstrap)
      // against a stable process instead of racing a restart loop.
      this.halted = false
      this.haltReason = null
      // When and at which committed height the halt was declared. Read back from
      // the store's R marker on a restart, so /status carries the ORIGINAL time
      // rather than this process's boot, which is what tells a monitor that the
      // fault is old and a restart did not clear it.
      this.haltedAt = null
      this.haltedHeight = null

      // Set while the sync loop is waiting out a node in initial block download
      // whose tip sits below our committed tip. The wait itself is silent past
      // the one latched log line, so without this an operator watching
      // `xchain-node ps` sees a tracker that has simply stopped advancing.
      // Shape: {node_height, stored_height, since} while waiting, null otherwise;
      // `since` is stamped once per wait so its age is the length of THIS wait.
      this.nodeCatchingUp = null

      // Set when the polling loop leaves by THROWING (the halt path) rather than
      // through its normal-stop branch, which is the only branch that closes the
      // store and sets parsingStopped. Tracked separately from `halted` because
      // `halted` is an operator-facing status that deliberately outlives a
      // relaunch, while this records the loop-lifecycle fact stopParsing acts on.
      this.parsingAborted = false

      // Coinbase maturity depth used by getUtxosAddress to withhold immature
      // coinbase outputs, resolved per coin/network (src/chain/coinbase_maturity.js).
      // Instance-scoped (not a bare const) so test harnesses that mine short
      // chains can relax it; production keeps the consensus default. Setting it
      // to 0 disables the gate. The resolver refuses an unresolvable chain
      // rather than defaulting, but it cannot newly reject a network that
      // constructs today: getBitcoinJsNetwork above already rejected anything
      // outside the registry's '<fullname>-<net>' keys, and every one of those
      // keys has a declared maturity.
      this.coinbaseMaturity = resolveCoinbaseMaturity(network)
    }
    

    // Tag/detect the unrecoverable-reorg fault class: the tracker has rolled back
    // past its UNDO_BLOCKS recovery window (or its in-memory last-blocks window is
    // empty), so it cannot reconstruct the UTXO set at the fork point from the
    // archived K/M records (already purged beyond the window). A process restart
    // re-hits the identical on-disk stale tip, so this fault must halt in place
    // rather than exit-for-restart (which crash-loops under Docker unless-stopped).
    static markUnrecoverableReorg(err){
        if (err && typeof err === 'object') err.unrecoverableReorg = true
        return err
    }

    static isUnrecoverableReorg(err){
        return !!(err && err.unrecoverableReorg === true)
    }

    // The halted state itself, shared by the live halt and the boot-time resume
    // from a persisted marker so the two cannot drift apart.
    enterHaltedState({ reason, at, height }){
        this.halted = true
        this.haltReason = reason
        this.haltedAt = at
        this.haltedHeight = height
        // The loop is gone (it threw, or was never started) and skipped the
        // normal-stop branch that sets parsingStopped. Record that: without it
        // stopParsing() can only time out, and both recovery RPCs open with that
        // wait, so the resync this halt exists to enable is unreachable on the one
        // state that needs it.
        this.parsingAborted = true
        this.parsingStopped = false
        if (this.mempoolInterval){ clearInterval(this.mempoolInterval); this.mempoolInterval = null }
    }

    // Write the R marker so the NEXT process boots straight into the halted state
    // (resumeHaltFromMarker) instead of rediscovering the fault by rolling back
    // into a window that is already drained. Stamps the committed height the halt
    // was declared at. Fail-soft: a store that cannot take the write (closed, or a
    // test stub) leaves the in-memory halt in force and says so once.
    async persistHaltMarker(){
        const store = this.db
        if (!store || typeof store.setHaltMarker !== 'function') return null
        try {
            if (this.haltedHeight === null) this.haltedHeight = await store.getLastBlockHeight()
            return await store.setHaltMarker({ reason: this.haltReason, height: this.haltedHeight, at: this.haltedAt })
        } catch (err) {
            logger.warn('[halted] could not persist the halt marker (' + (err && err.message)
                + '); the halt holds for this process, but a restart will rediscover it by rolling back')
            return null
        }
    }

    // Boot-time half of the marker: read it before the sync loop starts and, when
    // present, take the halted state without a rollback attempt or a throw. The
    // stored tip is the one already declared unrecoverable, so any attempt would
    // meet the same drained window, and a boot that halts silently only after that
    // reads as a fresh fault to a monitor watching the log. Returns true when the
    // caller (start) must stop here.
    async resumeHaltFromMarker(){
        let marker = null
        try {
            marker = await this.db.getHaltMarker()
        } catch (_) {
            // A store that cannot answer for the one diagnostic key boots as usual.
        }
        if (!marker) return false
        this.enterHaltedState({ reason: marker.reason, at: marker.at, height: marker.height })
        logger.error('[halted] marker from ' + (marker.at || 'unknown time') + ' at height '
            + (marker.height === null ? 'unknown' : marker.height) + ': ' + marker.reason)
        return true
    }

    // Drop the R marker from whichever store is open. Fail-soft for the same
    // reason the write is: on the restore path the old store is already closed
    // and wiped, so there is nothing to delete and the replacement store carries
    // its own answer when start() reads it.
    async deleteHaltMarker(){
        const store = this.db
        if (!store || typeof store.deleteHaltMarker !== 'function') return false
        try {
            await store.deleteHaltMarker()
            return true
        } catch (_) {
            return false
        }
    }

    

    

    

    

    

    

    
    // A coinbase transaction is the block's generation tx: exactly one input
    // whose prevout index is 0xFFFFFFFF (the same marker the input passes use to
    // skip tracing it). Its outputs are unspendable until this chain's coinbase
    // maturity depth (this.coinbaseMaturity), so they must be marked at insert time.
    // Pure freshness computation shared by the API's per-query freshness surface
    // and its regression test, so the lag/synced contract cannot drift.
    // lag is null when nothing is indexed yet or the node tip is unknown; callers
    // must treat null as "unknown, do not assume fresh", never as lag 0.
    // `state` carries the two readiness facts block-sync alone does not cover, so the
    // RPC freshness sibling says what REST's X-Mempool-Ready and get_sync_status's halt
    // marker already say and a consumer needs no second round-trip to learn them:
    //   mempool_ready - synced AND the mempool has reconverged at least once. synced
    //     flips true before the first (unawaited) updateMempool repopulates mempoolDb,
    //     so during that window a confirmed output already spent in the node mempool
    //     cannot be filtered out and reaches input selection.
    //   halted / halt_reason - the tracker stopped polling on an unrecoverable reorg.
    //     Emitted only when halted, matching get_sync_status, so the field's presence
    //     is itself the signal. halted_at / halted_height ride with them: the time and
    //     committed height the halt was FIRST declared, restored from the store's
    //     marker across restarts, so a monitor can tell an old fault from a new one.
    static computeFreshness(committedHeight, nodeTip, synced, state = {}){
        const { mempoolReconverged = false, halted = false, haltReason = null,
                haltedAt = null, haltedHeight = null } = state
        const tracker_height = (typeof committedHeight === 'number') ? committedHeight : -1
        const node_height    = (typeof nodeTip === 'number') ? nodeTip : -1
        const lag = (node_height >= 0 && tracker_height >= 0) ? (node_height - tracker_height) : null
        // Negative lag floors BOTH verdicts here, not only get_sync_status's. A committed
        // tip above the node's is the node-reset/reindex regression this class rolls back
        // from, so the outputs this sibling would authorize sit in blocks the node no
        // longer recognizes. The raw isSynced() flag is height-catchup state and knows
        // nothing of that regression, so without the floor get_utxos published
        // {lag:-100, synced:true, mempool_ready:true} for the same instant get_sync_status
        // published synced:false, and create_tx gates on THIS sibling.
        // Same floor deriveSyncedVerdict applies in api.js, so the two cannot disagree.
        const orphaned  = (lag !== null && lag < 0)
        const isSynced  = (synced === true) && !orphaned
        const freshness = {
            tracker_height, node_height, lag,
            synced: isSynced,
            mempool_ready: (isSynced && mempoolReconverged === true)
        }
        if (halted === true){
            freshness.halted        = true
            freshness.halt_reason   = haltReason
            freshness.halted_at     = haltedAt
            freshness.halted_height = haltedHeight
        }
        return freshness
    }

    static isCoinbaseTransaction(transaction){
        return Array.isArray(transaction.ins) && transaction.ins.length === 1
            && transaction.ins[0] && transaction.ins[0].index === 4294967295
    }

    // The depth guard's message. Names the remedy rather than the category,
    // because the operator most likely to read this line arrived by restoring a
    // published bootstrap whose tip had drifted: "resync from a known-good
    // snapshot" sends them back to the snapshot that put them here, and doing it
    // again halts again at the same block.
    //
    // States the fork's TOTAL depth: this pass's rollbacks plus everything a
    // previous process already walked back (the shortfall of the window at entry
    // against the deepest this store held), which is the number an operator
    // sizing a rebuild needs. An empty window at entry says so in its own words:
    // the nominal undoBlocks was never available to this pass, the previous
    // process spent all of what the store held, and the true depth is at least
    // that plus one.
    reorgExceedsWindowMessage({ windowAtEntry, watermarkAtEntry, heldBefore, spentBeforeEntry, lastBlockIndex, deletedThisPass }){
        let rolledBack
        if (windowAtEntry === 0 && watermarkAtEntry > 0){
            rolledBack = "The persisted undo window is EMPTY at entry: a previous process already "
                + "rolled back all " + heldBefore + " blocks this store held (of a nominal UNDO_BLOCKS="
                + this.undoBlocks + " window) before this restart, and the chain still diverges at "
                + "height " + lastBlockIndex + ", so the fork is at least " + (heldBefore + 1)
                + " blocks deep; "
        } else if (windowAtEntry === 0){
            rolledBack = "The persisted undo window is EMPTY at entry: a previous process already "
                + "rolled back every block this store held (up to the nominal UNDO_BLOCKS="
                + this.undoBlocks + "; this store predates the undo-window watermark, so the exact "
                + "count is unknown) before this restart, and the chain still diverges at height "
                + lastBlockIndex + ", so the fork is deeper than the window; "
        } else if (spentBeforeEntry > 0){
            rolledBack = "Already rolled back " + deletedThisPass + " blocks in this pass, "
                + "on top of " + spentBeforeEntry + " a previous process spent before this restart "
                + "(" + (spentBeforeEntry + deletedThisPass) + " of a "
                + this.undoBlocks + "-block window, now exhausted); "
        } else {
            rolledBack = "Already rolled back " + deletedThisPass + " blocks; "
        }
        return "verifyReorg: reorg depth exceeds the recovery window "
            + "(UNDO_BLOCKS=" + this.undoBlocks + "). " + rolledBack
            + "spent-output recovery records "
            + "for block height " + lastBlockIndex + " and below have already "
            + "been purged, so continuing would silently leave the UTXO index "
            + "under-counted. Aborting. Recovery: this index cannot be walked "
            + "back onto the node's chain and has to be rebuilt. Under xchain-node "
            + "run `xchain-node reset xchain-utxo-tracker <coin> <network>`, which "
            + "drops the volume and takes the bulk-sync path; standalone, stop the "
            + "tracker, empty its data directory and restart it. Restoring the same "
            + "bootstrap again lands back here if its tip is the drifted one."
    }

    
    
    async start(){
        this.db = new LevelUpStore(this.dbName)
        this.mempoolDb = new LevelUpStore("mempool"+this.dbName, true)
        await this.db.createDatabase()
        await this.mempoolDb.createDatabase()

        // A store already declared unrecoverable boots halted, with the original
        // time and height on /status, and never re-enters the loop: the window it
        // would roll back through is the drained one the marker was written over.
        if (await this.resumeHaltFromMarker()) return

        logger.info("Indexing...")

        let lastProcessedBlockIndex = await this.db.getLastBlockHeight()
        let lastProcessedBlockHash = await this.db.getLastBlockHash()

        // Load in ascending height order (tip last) so a reorg right after a
        // restart doesn't trip removeFromLastBlocks. See helper for detail.
        this.lastBlocks = await this.loadLastBlocksSortedByHeight()

        // Before the diagnostic: it is the watermark that says whether a short
        // window is a rollback that was interrupted or one that never got deeper.
        await this.loadUndoWindowWatermark()

        this.noteInterruptedReorgWindow(lastProcessedBlockIndex)

        // Recover any K/M cleanup work that was staged but not completed before a prior crash.
        // abstract-level .get returns undefined on a missing key (no throw); real
        // I/O errors still propagate. Clear first: start() re-runs on the SAME tracker
        // object after restorebootstrap replaces the store, and the read below only
        // assigns when the P key exists, so without this the restored database inherits
        // the previous database's pending list and cleanupAgedBlocks prunes K/M/W/Z
        // records against block hashes that store never held.
        this.pendingKMCleanup = []
        const pVal = await this.db.db.get(P_PENDING_CLEANUP_KEY)
        if (pVal !== undefined) {
            this.pendingKMCleanup = JSON.parse(pVal.toString())
            if (this.pendingKMCleanup.length > 0) {
                logger.info(`Recovering ${this.pendingKMCleanup.length} pending K/M cleanup block(s) from prior crash`)
            }
        }

        let lastBlockchainInfo = null
        let lastBlockchainInfoRefreshAt = 0
        // Instance-visible twin of lastBlockchainInfoRefreshAt, read by GET /status.
        // The loop below retries a failing getBlockchainInfo forever, so a coin node
        // that is down or unsynced stalls block tracking while LevelDB stays perfectly
        // readable and the DB-only probe kept reporting 'ok'. Seeded here
        // rather than in the constructor so the window starts when tracking starts.
        this.lastNodeRpcOkAt = Date.now()
        this.blockchainInfoLastBlock = -1
        let blocksQuantity = 0
        // Transactions confirmed in this batch that need their mempool records
        // removed. Collected per-block and flushed AFTER db.endTransaction() so
        // confirmed outputs are always committed before mempool records are deleted,
        // closing the brief "in neither store" window described in the ordering fix.
        let pendingMempoolTxCleanup = []
        
        let blockTimestamps = [] // Rolling window of {height, time, txCount} for ETA calculation
        let _t = { fetch: 0, decode: 0, parse: 0, parseOut: 0, parseIn: 0, commit: 0, cleanup: 0, blocks: 0 }
        let pendingCommit = null

        let blocksToInsert = []
        let transactionsToInsert = []
        let inputsToInsert = []
        let outputsToInsert = []
        
        let blocksCount = 0
        let transactionsCount = 0
        let inputsCount = 0
        let outputsCount = 0
        
        this.keepParsing = true
        this.parsingStopped = false
        // A relaunched loop is running again, so the previous abort no longer
        // describes it; leaving this set would let stopParsing close a live store.
        this.parsingAborted = false

        // Prefetch queue: each entry is { height, promise } where promise resolves to { hash, hex }
        let prefetchQueue = []

        const fetchBlock = async (height) => {
            const hash = await this.connector.getBlockHash(height)
            const hex = this.auxPow
                ? await this.connector.getBlockWithoutAuxPow(hash)
                : await this.connector.getBlock(hash)
            return { hash, hex }
        }

        const fillPrefetchQueue = (fromHeight, tipHeight) => {
            let maxQueued = fromHeight - 1
            if (prefetchQueue.length > 0) {
                maxQueued = prefetchQueue[prefetchQueue.length - 1].height
            }

            // Collect all heights that still need to be queued
            const heights = []
            while (prefetchQueue.length + heights.length < PREFETCH_SIZE && maxQueued + 1 <= tipHeight) {
                maxQueued++
                heights.push(maxQueued)
            }
            if (heights.length === 0) return

            if (this.auxPow) {
                // AuxPoW: one batch HTTP request each for getblockhash + getblockheader + getblock,
                // stripping the AuxPoW header bytes per block (getBlocksBatchWithoutAuxPow)
                const batchPromise = this.connector.getBlocksBatchWithoutAuxPow(heights)
                heights.forEach((h, i) => {
                    const p = batchPromise.then(results => ({ hash: results[i].hash, hex: results[i].hex }))
                    p.catch(() => {}) // suppress unhandled rejection if entry is cleared from queue before being awaited
                    prefetchQueue.push({ height: h, promise: p })
                })
            } else {
                // Non-AuxPoW: one batch HTTP request for all getblockhash + one for all getblock
                const batchPromise = this.connector.getBlocksBatch(heights)
                heights.forEach((h, i) => {
                    const p = batchPromise.then(results => ({ hash: results[i].hash, hex: results[i].hex }))
                    p.catch(() => {}) // suppress unhandled rejection if entry is cleared from queue before being awaited
                    prefetchQueue.push({ height: h, promise: p })
                })
            }
        }

        let nodeSyncedProblem = false
        // Node-tip-below-ours latches, one line per transition each: the node is
        // still in initial block download (wait, never reconcile), or the gap is
        // too deep to walk back and verifyReorg refused before deleting (wait,
        // keep serving, say so once).
        let nodeCatchingUpProblem = false
        let tipBelowCommittedTipRefused = false

        // Track consecutive block-fetch failures at the SAME height. A node
        // pruned past our cursor (or any permanent fetch fault) otherwise retries
        // every 3s forever with no fail-loud signal. Reset on any successful fetch
        // or a height change so ordinary transient blips never accumulate toward
        // the desync threshold.
        let blockFetchFailures = 0
        let blockFetchFailureHeight = null

        // A SECOND streak, counting only AuxPoW-strip (content) faults. The one
        // above answers "can this node serve this block at all" and drives the
        // fail-loud desync halt; this one answers "are this block's bytes the
        // problem" and is the only thing allowed to trigger per-tx reassembly.
        // Merging them aimed the reassembly RPC fan-out at whatever node had just
        // gone unreachable for five polls.
        let auxPowParseFailures = 0
        let auxPowParseFailureHeight = null

        while (true){
            if (this.keepParsing){
                // Refresh node tip when: no info yet, caught up to the previously-seen tip,
                // OR periodically so blockchainInfoLastBlock stays current during catch-up
                // (synced flag and confirmations reflect the true tip, not a frozen startup value).
                //Getting the last block from the blockchain.
                //Refresh when we have no info yet, when we have caught up to the
                //previously-seen tip, OR periodically on a wall-clock interval: the
                //last condition keeps blockchainInfoLastBlock tracking the live chain
                //during a long catch-up, so the synced flag and reported confirmations
                //reflect the true chain tip instead of a frozen startup value.
                if (!lastBlockchainInfo
                    || (lastProcessedBlockIndex >= this.blockchainInfoLastBlock)
                    || (Date.now() - lastBlockchainInfoRefreshAt >= BLOCKCHAIN_INFO_REFRESH_MS)){
                    try {
                        lastBlockchainInfo = await this.connector.getBlockchainInfo()
                        this.latestKnownChainTip = lastBlockchainInfo["blocks"]

                        if (lastBlockchainInfo["verificationprogress"] < MIN_VERIFICATION_PROGRESS_TO_PARSE){
                            if (!nodeSyncedProblem){
                                logger.info("The node is not synced. Waiting for it to synchronize...")
                            }

                            lastBlockchainInfo = null
                            nodeSyncedProblem = true
                            await this.sleep(3000)
                            continue
                        } else {
                            nodeSyncedProblem = false
                        }

                        this.blockchainInfoLastBlock = lastBlockchainInfo["blocks"]
                        lastBlockchainInfoRefreshAt = Date.now()
                        // Stamped only here, past the verification-progress gate, so
                        // "node RPC ok" means a USABLE tip: an unsynced node that answers
                        // and a node that does not answer both age this timestamp out.
                        // Never stamped in the catch below.
                        this.lastNodeRpcOkAt = lastBlockchainInfoRefreshAt
                    } catch (e){
                        logger.error(nodeUtil.format('Error fetching blockchain info from node: ' + e.message, e))
                        await this.sleep(3000)
                        continue
                    }

                    // The usual way a catch-up wait ends: the node's tip reached ours,
                    // so the branch below is not entered at all and the published wait
                    // would otherwise stay on the health surfaces for the rest of the
                    // process. Only the state is cleared here; the latched log lines are
                    // left to their own transition below.
                    if (this.nodeCatchingUp && lastProcessedBlockIndex <= this.blockchainInfoLastBlock){
                        this.nodeCatchingUp = null
                    }

                    if (lastProcessedBlockIndex > this.blockchainInfoLastBlock){
                        // A node still in initial block download has not validated up
                        // to our height yet; its tip below ours is a node catching up,
                        // not a rollback. Wait for it to pass the committed tip and let
                        // the forward hash compare decide. Same hazard the decoder hit
                        // on an operator's fresh BTC mainnet node 2026-09-07: walking
                        // back here spends the whole undo window on a reorg that never
                        // happened and halts for a rebuild.
                        if (nodeStillCatchingUp(lastBlockchainInfo)){
                            if (!nodeCatchingUpProblem){
                                logger.warn("WARNING! The last processed block height ("+lastProcessedBlockIndex+") is greater than the last block from the network ("+this.blockchainInfoLastBlock+"), but the node reports initialblockdownload=true: it is still catching up, not rolled back. Waiting for it to pass "+lastProcessedBlockIndex+" instead of rolling back; the hash compare decides then.")
                            }
                            nodeCatchingUpProblem = true
                            // Publish it; past the latched line the wait is invisible.
                            this.nodeCatchingUp = catchUpWaitState(this.nodeCatchingUp,
                                this.blockchainInfoLastBlock, lastProcessedBlockIndex)
                            await this.sleep(5000)
                            continue
                        }
                        if (nodeCatchingUpProblem){
                            logger.info("The node has left initial block download with its tip ("+this.blockchainInfoLastBlock+") still below the last processed block ("+lastProcessedBlockIndex+"); treating the gap as a rollback from here on.")
                            nodeCatchingUpProblem = false
                            this.nodeCatchingUp = null
                        }

                        // Discard any in-flight batch before recovery runs. A
                        // periodic refresh can reach here mid-batch; leaving the staged
                        // batch open would leak phantom UTXOs or break per-block atomicity
                        // once verifyReorg opens its own transaction. Rationale in full at
                        // discardInflightBatchForReorg(). Zero the local batch counters
                        // here since they live in this closure, not on the instance.
                        if (await this.discardInflightBatchForReorg(blocksQuantity)){
                            blocksQuantity = 0
                            blocksCount = 0
                            transactionsCount = 0
                            inputsCount = 0
                            outputsCount = 0
                            pendingMempoolTxCleanup = []
                            blockTimestamps = []
                        }

                        //This shouldn't happen, but let's try to find the real lastBlockIndex
                        logger.info("The last processed block height are greater than the last block of the node. Trying to fix the lastBlockIndex stored in db. This could take some minutes...")
                        let lastBlockDb = await this.db.getLastBlock()

                        // getLastBlock() returns null when the B-prefix is empty. With
                        // a committed height above the node tip but no block records,
                        // the true tip can't be recovered; surface a clear, actionable
                        // error instead of a bare TypeError on lastBlockDb.height below.
                        if (!lastBlockDb){
                            throw new Error("Tracker DB corrupt: committed height " + lastProcessedBlockIndex +
                                " exceeds the node tip " + this.blockchainInfoLastBlock + " but the block index " +
                                "(B-prefix) is empty, so the true tip cannot be recovered. Recovery: full resync " +
                                "from a known-good snapshot.")
                        }

                        if (lastBlockDb.height > this.blockchainInfoLastBlock){
                            // True regression: the node's tip is genuinely below our committed
                            // tip (node reset / reindex / invalidateblock). Roll back onto the
                            // node's chain instead of warn-and-spin. Without this we fall through,
                            // try to fetch block N+1 the node doesn't have, loop forever, and keep
                            // serving the orphaned tip's UTXOs. verifyReorg(nodeTip) deletes the
                            // blocks above the node tip, then reconciles by hash, honoring the
                            // undoBlocks depth guard (a regression deeper than the window aborts
                            // loudly for an operator-driven resync).
                            // console.warn, not console.log: the line says WARNING but a
                            // collector keys severity on the console method, so at info level
                            // this tip regression is filed as routine progress. See the
                            // reorg-detection-warn-level drift guard.
                            if (!tipBelowCommittedTipRefused){
                                logger.warn("WARNING! The last processed block height ("+lastBlockDb.height+") is greater than the last block from the network ("+this.blockchainInfoLastBlock+"). The node likely reset or reorged below our tip; rolling back to its chain.")
                            }
                            this.lastBlocks = await this.loadLastBlocksSortedByHeight()
                            try {
                                await this.verifyReorg(this.blockchainInfoLastBlock)
                            } catch (err){
                                // A gap deeper than the undo window, refused BEFORE any
                                // delete (nothing walked back, index intact). Neither exit
                                // (a restart lands in the same refusal) nor haltForResync
                                // (nothing needs rebuilding) fits: stay up, say it once,
                                // and re-check the tip every poll so a node that is merely
                                // catching up without reporting IBD resolves it on its own.
                                if (err && err.tipBelowCommittedTip){
                                    if (!tipBelowCommittedTipRefused){
                                        logger.error(err.message)
                                    }
                                    tipBelowCommittedTipRefused = true
                                    await this.sleep(5000)
                                    continue
                                }
                                throw err
                            }
                            tipBelowCommittedTipRefused = false
                            lastProcessedBlockIndex = await this.db.getLastBlockHeight()
                            lastProcessedBlockHash = await this.db.getLastBlockHash()
                            continue
                        } else {
                            // Same repair as verifyReorg's, and it needs the same own
                            // batch: bare setters STAGE, and at boot they stage into the
                            // constructor Map nothing commits, which makes the log line
                            // below claim a fix that never reaches disk. The
                            // discardInflightBatchForReorg() call above satisfies the
                            // precondition. Rationale at commitLastBlockPointerRepair().
                            await this.commitLastBlockPointerRepair(lastBlockDb.hash, lastBlockDb.height)
                            lastProcessedBlockIndex = lastBlockDb.height
                            lastProcessedBlockHash = lastBlockDb.hash
                            logger.info("Last block index was fixed!")
                            continue
                        }
                    }
                }
                
                //If there is no new block, wait for some seconds to ask again
                if (lastProcessedBlockIndex == this.blockchainInfoLastBlock){
                    this.synced = true

                    // Same-height tip reorg detection. While synced we otherwise never
                    // re-check the committed tip hash, so a node that replaces its tip at
                    // the same height and then stalls would have us keep serving the
                    // orphaned block's UTXOs until a new height arrives. Cheaply re-compare
                    // the committed tip hash against the node each synced poll; on a
                    // mismatch drive verifyReorg to roll back to the common ancestor.
                    if (lastProcessedBlockIndex > 0){
                        let tipHashFromNode = null
                        try {
                            tipHashFromNode = await this.connector.getBlockHash(lastProcessedBlockIndex)
                        } catch (err){
                            logger.error(nodeUtil.format('Error re-checking the committed tip hash from node: ' + err.message, err))
                        }
                        if (tipHashFromNode && tipHashFromNode != lastProcessedBlockHash){
                            // console.warn: a tip swap at the same height is a reorg, and it
                            // must leave a warn-level record even if verifyReorg then wedges
                            // before reorgCount/last_reorg_depth advance.
                            logger.warn("A same-height tip reorg has been detected. Cleaning blocks...")
                            prefetchQueue = []
                            // Discard any in-flight batch before recovery, exactly as the
                            // prev-hash-mismatch and true-regression reorg paths do. This
                            // branch is reachable MID-BATCH: the in-memory cursor advances
                            // per staged block while the tip pointer is only staged at flush,
                            // so a periodic blockchain-info refresh can lower the node tip to
                            // exactly the staged cursor height on a competing chain, landing
                            // here with blocksQuantity > 0. verifyReorg opens its own
                            // transaction, so leaving the stale batch open would either commit
                            // orphan-chain records as phantom UTXOs at the next flush, or (once
                            // verifyReorg nulls transactionArray) route later writes as unbatched
                            // direct puts while blocksQuantity stays > 0. Rationale in full at
                            // discardInflightBatchForReorg().
                            await this.db.endTransaction(false)
                            // The rolled-back batch dropped the P-key write recording aged-out
                            // blocks awaiting K/M cleanup; persist it out-of-band so restart
                            // recovery still runs it (same standalone put the prev-hash path uses).
                            if (this.pendingKMCleanup.length > 0) {
                                await this.db.db.put(P_PENDING_CLEANUP_KEY,
                                    Buffer.from(JSON.stringify(this.pendingKMCleanup)))
                            }
                            this.lastBlocks = await this.loadLastBlocksSortedByHeight()
                            await this.verifyReorg()
                            lastProcessedBlockIndex = await this.db.getLastBlockHeight()
                            lastProcessedBlockHash = await this.db.getLastBlockHash()
                            // Run the deferred K/M/W cleanup now (cleanupAgedBlocks skips any
                            // hash still in the reloaded live window) and delete the P key
                            // atomically, then zero the loop-local batch counters that live in
                            // this closure so the next block opens a fresh batch.
                            await this.cleanupAgedBlocks()
                            blocksQuantity = 0
                            blocksCount = 0
                            transactionsCount = 0
                            inputsCount = 0
                            outputsCount = 0
                            this.pendingKMCleanup = []
                            pendingMempoolTxCleanup = []
                            blockTimestamps = []
                            continue
                        }
                    }

                    if (this.mempoolInterval == null){
                        logger.info("Mempool updates started!")
                        this.updateMempool()
                        this.mempoolInterval = setInterval(this.updateMempool.bind(this), MEMPOOL_INTERVAL)
                    }

                    await this.sleep(CHECK_BLOCK_DELAY_MS)
                } else {
                    //Put the flag synced false if there are too many blocks behind
                    if ((this.blockchainInfoLastBlock - lastProcessedBlockIndex) > SYNCED_THRESHOLD){
                        this.synced = false
                        // Falling out of sync invalidates mempool readiness: the
                        // mempool poller is torn down here and must reconverge once
                        // before readiness is asserted again.
                        this.mempoolReconverged = false
                        if (this.mempoolInterval != null){
                            logger.info("Mempool updates stopped!")
                            clearInterval(this.mempoolInterval)
                            this.mempoolInterval = null
                        }
                    }

                    //Get the next block
                    let nextBlockHeight = lastProcessedBlockIndex + 1

                    // Kick off pre-fetches for upcoming blocks while we process the current one
                    fillPrefetchQueue(nextBlockHeight, this.blockchainInfoLastBlock)

                    let nextBlockHash = null
                    let nextBlockHex = null
                    try {
                        let fetched
                        if (this.shouldReassembleBlock(nextBlockHeight, auxPowParseFailureHeight, auxPowParseFailures)) {
                            // The AuxPoW STRIP has failed this many times at this height,
                            // which is evidence about the block's bytes rather than the
                            // node's health: bypass the prefetch queue (its batch strip
                            // would just fail the same way) and rebuild the pure block
                            // per-tx, never reading the AuxPoW bytes.
                            logger.error('AuxPoW strip at height ' + nextBlockHeight + ' failed ' + auxPowParseFailures +
                                ' consecutive times; falling back to per-tx block reassembly (malformed-AuxPoW recovery).')
                            prefetchQueue = []
                            const hash = await this.connector.getBlockHash(nextBlockHeight)
                            fetched = { hash, hex: await this.connector.getBlockReassembled(hash) }
                        } else if (prefetchQueue.length > 0 && prefetchQueue[0].height === nextBlockHeight) {
                            fetched = await prefetchQueue.shift().promise
                        } else {
                            // Queue is out of sync (e.g. after reorg), fetch directly
                            prefetchQueue = []
                            fetched = await fetchBlock(nextBlockHeight)
                        }
                        nextBlockHash = fetched.hash
                        nextBlockHex = fetched.hex
                        // Successful fetch: clear the desync streak so a future
                        // transient blip starts counting from zero again, and the
                        // parse streak with it (this block's bytes are readable, by
                        // the strip or by reassembly).
                        blockFetchFailures = 0
                        blockFetchFailureHeight = null
                        auxPowParseFailures = 0
                        auxPowParseFailureHeight = null
                    } catch (e){
                        prefetchQueue = []
                        // noteBlockFetchFailure counts consecutive failures at this
                        // height and THROWS a diagnosable desync error once the bound
                        // is hit, so a node pruned past our cursor fails loud instead
                        // of spinning every 3s forever. It counts EVERY failure; the
                        // parse streak beside it counts only the tagged content faults
                        // that may escalate to reassembly.
                        const _p = this.noteAuxPowParseFailure(nextBlockHeight, auxPowParseFailureHeight, auxPowParseFailures, e)
                        auxPowParseFailureHeight = _p.height
                        auxPowParseFailures = _p.count
                        const _s = this.noteBlockFetchFailure(nextBlockHeight, blockFetchFailureHeight, blockFetchFailures, e)
                        blockFetchFailureHeight = _s.height
                        blockFetchFailures = _s.count
                        await this.sleep(BLOCK_FETCH_RETRY_SLEEP_MS)
                        continue
                    }
                    
                    const _tDecode = Date.now()
                    var block = this.xchainBlockDecoder.blockFromHex(nextBlockHex)
                    let previousBlockHash = util.uint8ArrayToHex(Buffer.from(block.prevHash).reverse())
                    _t.decode += Date.now() - _tDecode

                    //Check if there is a reorg
                    if (nextBlockHeight > 0){
                        //previousBlockHash is not the same, it must be a reorg
                        if (previousBlockHash != lastProcessedBlockHash){
                            prefetchQueue = []
                            await this.db.endTransaction(false)
                            // The rolled-back batch discarded the P-key write that
                            // records aged-out blocks awaiting K/M cleanup, but those
                            // blocks are too old to reorg and still need cleaning.
                            // Persist the list with a standalone put on the underlying
                            // store, deliberately outside the transaction just rolled
                            // back, so the startup recovery path runs cleanupAgedBlocks()
                            // for them on the next restart instead of stranding the
                            // entries on disk.
                            if (this.pendingKMCleanup.length > 0) {
                                await this.db.db.put(P_PENDING_CLEANUP_KEY,
                                    Buffer.from(JSON.stringify(this.pendingKMCleanup)))
                            }
                            // Reload in ascending height order (tip last); the raw
                            // getLastStoredBlocks() order is lexicographic by hash,
                            // which makes verifyReorg's removeFromLastBlocks throw.
                            this.lastBlocks = await this.loadLastBlocksSortedByHeight()
                            // console.warn: the prev-hash-mismatch path is the ordinary reorg
                            // trigger, so leaving it at info is what makes a routine reorg
                            // invisible to a warn+ filter.
                            logger.warn("A reorg has been detected. Cleaning blocks...")
                            await this.verifyReorg()
                            lastProcessedBlockIndex = await this.db.getLastBlockHeight()
                            lastProcessedBlockHash = await this.db.getLastBlockHash()

                            // The P key was persisted above (standalone put, outside the
                            // rolled-back batch) so a restart would re-run cleanupAgedBlocks.
                            // Run it now so aged-out K/M/W records are purged immediately
                            // and the P key is deleted atomically, not left on disk until
                            // the next restart or flush.
                            await this.cleanupAgedBlocks()

                            blocksQuantity = 0
                            blocksCount = 0
                            transactionsCount = 0
                            inputsCount = 0
                            outputsCount = 0
                            this.pendingKMCleanup = []
                            pendingMempoolTxCleanup = []
                            blockTimestamps = []
                            logger.info("Blocks were updated")
                            continue
                        }
                    }
                    //Start a transaction if there are no blocks processed yet
                    if (blocksQuantity == 0){
                        await this.db.beginTransaction()
                    }

                    //Insert the processed block
                    await this.db.insertBlock({hash:nextBlockHash, height:nextBlockHeight, timestamp:block.timestamp, previousHash:previousBlockHash})
                    blocksCount = blocksCount + 1               
                    
                    //Parse the transactions (two-pass approach to allow full parallelism):
                    //  Pass 1: insert all outputs for every tx concurrently
                    //  Pass 2: process all inputs concurrently (same-block outputs are
                    //          now in transactionArray so removeOutputWithInput finds them)
                    var transactions = block.transactions

                    const _tParse = Date.now()
                    const _tParseOut = Date.now()
                    // Sequential in tx-index order so that S-record writes across
                    // txs in the same block land in deterministic (tx-index, vout)
                    // order, matching bulk-sync.
                    const blockOutputCounts = new Array(transactions.length)
                    for (let txIdx = 0; txIdx < transactions.length; txIdx++) {
                        blockOutputCounts[txIdx] = await this.parseTxOutputs(
                            this.db, transactions[txIdx], nextBlockHash, nextBlockHeight, false, REMOVE_SPENT
                        )
                    }
                    _t.parseOut += Date.now() - _tParseOut
                    // Pass 2: collect all inputs across the block, then batch-remove
                    const _tParseIn = Date.now()
                    const removeInputs = []
                    for (const tx of transactions) {
                        for (const nextInput of tx.ins) {
                            const standardInput = ("standard_input" in nextInput ? nextInput["standard_input"] : true)
                            // A coinbase input spends nothing, so there is no previous output to remove.
                            if ((nextInput.index === 4294967295) || !standardInput) continue
                            const prevTxHash8 = util.uint8ArrayToHex(Buffer.from(nextInput.hash).reverse()).substring(0, 16)
                            removeInputs.push({ prevTxHash: prevTxHash8, prevOutputIndex: nextInput.index, blockHash: nextBlockHash })
                        }
                    }
                    let blockInputTotal = removeInputs.length
                    if (removeInputs.length > 0) {
                        await this.db.removeOutputsWithInputsBatch(removeInputs)
                    }
                    _t.parseIn += Date.now() - _tParseIn
                    _t.parse += Date.now() - _tParse

                    transactionsCount = transactionsCount + transactions.length
                    outputsCount = outputsCount + blockOutputCounts.reduce((acc, n) => acc + n, 0)
                    inputsCount  = inputsCount  + blockInputTotal

                    // Collect txids for mempool cleanup. The actual deletions are
                    // deferred to after db.endTransaction() at flush time so that
                    // confirmed outputs are always committed before their mempool
                    // records are removed, closing the window where a just-mined
                    // UTXO would transiently appear in neither the confirmed nor
                    // the mempool store. The cleanup is a no-op for txs the
                    // mempool poll never saw (most in regtest).
                    for (const tx of transactions) {
                        pendingMempoolTxCleanup.push("id" in tx ? tx["id"] : tx.getId())
                    }

                    //Add the block to the last blocks
                    await this.addToLastBlocks(nextBlockHash)

                    // Flush triggers: batch full, at chain tip, or heap pressure.
                    //If there are enough processed blocks, then add them to the database.
                    //Three triggers: batch full, at chain tip, or heap under pressure.
                    //Heap-pressure flush keeps the block-count constant working as an
                    //upper bound while preventing V8 OOM on dense chain windows where a
                    //full 200-block batch would push staged Buffers past the heap cap.
                    const _earlyFlushHeapMB = process.memoryUsage().heapUsed / 1048576
                    const _flushReason =
                        (nextBlockHeight == this.blockchainInfoLastBlock)             ? 'tip' :
                        (blocksQuantity == DB_TRANSACTION_BLOCKS_QUANTITY-1)          ? 'batch-full' :
                        (_earlyFlushHeapMB > HEAP_FLUSH_THRESHOLD_MB)                 ? 'heap-pressure' :
                        null
                    if (_flushReason){
                        logger.info("Indexing block "+(nextBlockHeight)+"("+nextBlockHash+")")
                        await this.db.setLastBlockHeight(nextBlockHeight)
                        await this.db.setLastBlockHash(nextBlockHash)
                        logger.info("Inserting data Blocks ("+blocksCount+") Transactions ("+transactionsCount+") Inputs ("+inputsCount+") Outputs("+outputsCount+")")

                        // Atomically record which blocks need K/M cleanup so a crash between
                        // endTransaction and cleanupAgedBlocks is recoverable on restart.
                        if (this.pendingKMCleanup.length > 0) {
                            await this.db.addTransaction("put", P_PENDING_CLEANUP_KEY,
                                Buffer.from(JSON.stringify(this.pendingKMCleanup)))
                        }

                        const _tCommit = Date.now()
                        await this.db.endTransaction()
                        _t.commit += Date.now() - _tCommit

                        // Stamp the forward-progress heartbeat only after the batch is
                        // durable, so a crash mid-flush cannot leave /metrics claiming a
                        // commit the DB never took.
                        this.lastCommitAt = Date.now()
                        this.lastCommittedHeight = nextBlockHeight

                        // Flush deferred mempool cleanup AFTER confirmed outputs are committed.
                        // This closes the ordering gap: mined UTXOs are queryable from the
                        // confirmed DB before their mempool records are removed, so no query
                        // window exists where the output appears in neither store.
                        // deleteOutputsByHint/deleteInputsByHint are per-entry read streams that
                        // yield to the event loop, so wrap in a transaction for atomicity and
                        // wait for any in-flight updateMempool() to release the mutex first.
                        if (pendingMempoolTxCleanup.length > 0) {
                            while (this.mempoolBusy) {
                                await this.sleep(50)
                            }
                            this.mempoolBusy = true
                            try {
                                await this.mempoolDb.beginTransaction()
                                for (const txid of pendingMempoolTxCleanup) {
                                    await this.mempoolDb.deleteOutputsByHint(txid)
                                    await this.mempoolDb.deleteInputsByHint(txid)
                                    await this.mempoolDb.deleteTransaction(txid)
                                }
                                await this.mempoolDb.endTransaction()
                            } finally {
                                this.mempoolBusy = false
                            }
                            pendingMempoolTxCleanup = []
                        }

                        // Clean up K/M entries for aged-out blocks now that the batch is committed
                        const _tCleanup = Date.now()
                        await this.cleanupAgedBlocks()
                        _t.cleanup += Date.now() - _tCleanup

                        // ── Print timing summary ──
                        _t.blocks = blocksQuantity + 1
                        const _total = _t.decode + _t.parse + _t.commit + _t.cleanup
                        const _pb = XChainUtxoTracker.parseOutBuckets
                        const _pi = LevelUpStore.parseInBuckets
                        const _ks = LevelUpStore.knownScripts
                        const _ksH = LevelUpStore.knownScriptsHits
                        const _ksM = LevelUpStore.knownScriptsMisses
                        const _ksRate = _ksH + _ksM > 0 ? ((_ksH / (_ksH + _ksM)) * 100).toFixed(1) : '0.0'
                        const _mem = process.memoryUsage()
                        const _heapMB = (_mem.heapUsed / 1048576).toFixed(0)
                        const _rssMB = (_mem.rss / 1048576).toFixed(0)
                        const _ocSize = LevelUpStore.outputCache.size
                        logger.info(`⏱ TIMING (${_t.blocks} blocks) flush=${_flushReason} total=${_total}ms | decode=${_t.decode}ms | parse=${_t.parse}ms (out=${_t.parseOut}ms [hash=${_pb.hash}ms ins=${_pb.ins}ms sb=${_pb.sb}ms] in=${_t.parseIn}ms [hintRead=${_pi.hintRead}ms outRead=${_pi.outRead}ms stage=${_pi.stage}ms]) | commit=${_t.commit}ms | cleanup=${_t.cleanup}ms | knownScripts=${_ks.size} hit=${_ksH} miss=${_ksM} rate=${_ksRate}% | heap=${_heapMB}MB heapPre=${_earlyFlushHeapMB.toFixed(0)}MB rss=${_rssMB}MB outCache=${_ocSize}`)
                        XChainUtxoTracker.parseOutBuckets = { hash: 0, ins: 0, sb: 0 }
                        LevelUpStore.parseInBuckets = { hintRead: 0, outRead: 0, stage: 0 }
                        LevelUpStore.knownScriptsHits = 0
                        LevelUpStore.knownScriptsMisses = 0

                        // Rolling ETA based on tx throughput; window is a span of
                        // ETA_WINDOW_BLOCKS blocks, not a count of samples. Each sample
                        // covers DB_TRANSACTION_BLOCKS_QUANTITY blocks, so a count-based
                        // trim would keep ~200× more history than intended.
                        blockTimestamps.push({height: nextBlockHeight, time: Date.now(), txCount: transactionsCount})
                        while (blockTimestamps.length >= 2 &&
                               (nextBlockHeight - blockTimestamps[0].height) > ETA_WINDOW_BLOCKS) {
                            blockTimestamps.shift()
                        }

                        _t = { fetch: 0, decode: 0, parse: 0, parseOut: 0, parseIn: 0, commit: 0, cleanup: 0, blocks: 0 }
                        blocksCount = 0
                        transactionsCount = 0
                        inputsCount = 0
                        outputsCount = 0

                        let blocksLeft = this.blockchainInfoLastBlock - nextBlockHeight
                        if (blocksLeft > 0 && blockTimestamps.length >= 2) {
                            let oldest = blockTimestamps[0]
                            let newest = blockTimestamps[blockTimestamps.length - 1]
                            let totalTx = 0
                            for (let k = 1; k < blockTimestamps.length; k++) totalTx += blockTimestamps[k].txCount
                            let elapsedMs = newest.time - oldest.time
                            let msPerTx = elapsedMs / totalTx
                            let avgTxPerBlock = totalTx / (newest.height - oldest.height)
                            let msLeft = blocksLeft * avgTxPerBlock * msPerTx
                            logger.info(`⚡ Speed: ${(1000/msPerTx).toFixed(1)} tx/s | avg ${avgTxPerBlock.toFixed(0)} tx/block (last ${newest.height - oldest.height} blocks)`)
                            logger.info("Estimated time to finish: "+this.millisecondsToTimeString(msLeft))
                        }
                        
                        blocksQuantity = -1
                    }
                    
                    blocksQuantity = blocksQuantity + 1
                    lastProcessedBlockIndex = nextBlockHeight
                    lastProcessedBlockHash = nextBlockHash
                }
            } else {
                logger.info("Stopping the parsing...")
                if (this.mempoolInterval) {
                    clearInterval(this.mempoolInterval)
                    this.mempoolInterval = null
                }
                await this.db.close()
                this.parsingStopped = true
                break
            }
        }
    }
    

    
}

module.exports = XChainUtxoTracker

const lastBlocksWindowMethods = require('./XChainUtxoTracker/last_blocks_window.js')
const fetchFailuresAndHaltMethods = require('./XChainUtxoTracker/fetch_failures_and_halt.js')
const statusAndStopMethods = require('./XChainUtxoTracker/status_and_stop.js')
const addressQueryMethods = require('./XChainUtxoTracker/address_queries.js')
const transactionParsingMethods = require('./XChainUtxoTracker/transaction_parsing.js')
const reorgVerificationMethods = require('./XChainUtxoTracker/reorg_verification.js')
const mempoolRefreshMethods = require('./XChainUtxoTracker/mempool_refresh.js')

Object.assign(XChainUtxoTracker.prototype, lastBlocksWindowMethods,
    fetchFailuresAndHaltMethods, statusAndStopMethods, addressQueryMethods,
    transactionParsingMethods, reorgVerificationMethods, mempoolRefreshMethods)

// Attached to the class rather than exported one line at a time: one export
// shape per file, and every call site already reaches these through the module
// object, so nothing outside changes.
Object.assign(module.exports, {
    satoshiToDecimalString,
    SYNCED_THRESHOLD,
    nodeStillCatchingUp,
    catchUpWaitState,
    MAX_ADDRESS_OUTPUTS,
    MAX_BLOCK_FETCH_RETRIES,
    // Exported for the malformed-AuxPoW fallback regression test.
    AUXPOW_REASSEMBLE_AFTER,
    // The flat COINBASE_MATURITY scalar that stood here is gone: no caller in any
    // repo consumed it (verified by a grep for `.COINBASE_MATURITY` across the
    // platform), and a single exported number is the shape of the bug, since it can
    // only be right for one chain. Callers that need the depth read
    // tracker.coinbaseMaturity, or resolve it per network through this resolver.
    resolveCoinbaseMaturity,
})
