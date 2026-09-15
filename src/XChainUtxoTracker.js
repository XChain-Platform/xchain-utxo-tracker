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
const config = require('./config')
const coins = require('./coins')
const { assertBigIntBufferutils } = require('./chain/assert_bigint_bufferutils')
const crypto = require('crypto');
const bs58check = require('bs58check')
const bitcoin = require('bitcoinjs-lib')
const ecc = require('tiny-secp256k1')
const fs = require('fs')
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

const { SYNCED_THRESHOLD, DEBUG_TRACE, logger, MAX_ADDRESS_OUTPUTS, MAX_BLOCK_FETCH_RETRIES, AUXPOW_REASSEMBLE_AFTER } = require('./XChainUtxoTracker/constants.js')
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
}

module.exports = XChainUtxoTracker

const lastBlocksWindowMethods = require('./XChainUtxoTracker/last_blocks_window.js')
const fetchFailuresAndHaltMethods = require('./XChainUtxoTracker/fetch_failures_and_halt.js')
const statusAndStopMethods = require('./XChainUtxoTracker/status_and_stop.js')
const addressQueryMethods = require('./XChainUtxoTracker/address_queries.js')
const transactionParsingMethods = require('./XChainUtxoTracker/transaction_parsing.js')
const reorgVerificationMethods = require('./XChainUtxoTracker/reorg_verification.js')
const syncLoopMethods = require('./XChainUtxoTracker/sync_loop.js')
const mempoolRefreshMethods = require('./XChainUtxoTracker/mempool_refresh.js')

Object.assign(XChainUtxoTracker.prototype, lastBlocksWindowMethods,
    fetchFailuresAndHaltMethods, statusAndStopMethods, addressQueryMethods,
    transactionParsingMethods, reorgVerificationMethods, syncLoopMethods,
    mempoolRefreshMethods)

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
