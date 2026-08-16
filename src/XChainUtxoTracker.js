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

const util = require('./util')
const crypto = require('crypto');
const bs58check = require('bs58check')
const bitcoin = require('bitcoinjs-lib')
const ecc = require('tiny-secp256k1')
const { createHash } = require('crypto');
const fs = require('fs')
const LevelUpStore = require('./LevelUpDb.js')
const BlockchainConnector = require('./BlockchainConnector.js')
const CryptoNetworks = require('./CryptoNetworks')
const XChainBlockDecoder = require('./XChainBlockDecoder')
const bs = require("binary-search")
const { hrtime } = require('node:process');

// bitcoinjs-lib v6 needs an ECC backend registered before it can parse/validate
// Taproot (P2TR, witness v1) addresses. Without this, payments.p2tr() throws
// "No ECC Library provided" and getAddressType() silently classified every
// taproot address as 'unknown' (and any taproot balance/UTXO query mislabelled
// its outputs). Register once at module load.
bitcoin.initEccLib(ecc)

const CHECK_BLOCK_DELAY_MS = 1000 //1 second to continously ask for new block when all has been parsed
const BLOCKCHAIN_INFO_REFRESH_MS = 30000 //Re-poll the node tip at least this often during catch-up so the tracked tip stays current
const DB_TRANSACTION_BLOCKS_QUANTITY = 200
// Heap-pressure flush guard: modern BTC blocks (~4k tx avg, 10k+ in dense
// windows) accumulate ~17–90 MB of staged Buffer writes per block in
// `transactionArray`. A full 200-block batch can push V8 heap past the
// 4 GB --max-old-space-size cap mid-parse and abort the process. Flush
// early when heap exceeds this threshold so the block-count constant
// acts as an upper bound rather than the sole trigger.
const HEAP_FLUSH_THRESHOLD_MB = 2048
const PARSE_MODE_FILES = 0
const PARSE_MODE_BULK_INSERTS = 1
const SYNCED_THRESHOLD = 3
const SATOSHI_BIGINT = 100000000n
const DEBUG_TRACE = process.env.DEBUG_TRACE === 'true' || process.env.DEBUG_TRACE === '1'

// Exact satoshi -> decimal-string conversion. Plain float division (value / 1e8)
// loses precision once a total exceeds Number.MAX_SAFE_INTEGER (e.g. DOGE balances
// above ~90M), so all balance/amount formatting goes through this BigInt path.
function satoshiToDecimalString(satoshis) {
    const val = BigInt(satoshis)
    const abs = val < 0n ? -val : val
    const whole = abs / SATOSHI_BIGINT
    const frac = abs % SATOSHI_BIGINT
    return (val < 0n ? '-' : '') + whole.toString() + '.' + frac.toString().padStart(8, '0')
}
const MEMPOOL_INTERVAL = 60000
const MEMPOOL_BATCH_SIZE = 1000
// Breathing room between mempool batches (CPU/IO). Kept small so the cumulative
// inter-batch sleep stays well under MEMPOOL_INTERVAL even for large mempools
// (e.g. 50k txs => 49 sleeps => ~73.5s of sleep at 1500ms, vs ~490s at 10s),
// which previously kept mempoolBusy locked across every interval tick and left
// pending-balance queries stale for the whole multi-batch window.
const MEMPOOL_INTER_BATCH_SLEEP = 1500
// Max consecutive getRawTransactions failures before we abandon this mempool
// pass. The node going down mid-pass would otherwise spin this retry loop
// forever, never reaching the outer finally that clears the busy flag.
const MEMPOOL_MAX_TX_FETCH_RETRIES = 5
// Consecutive block-fetch failures at the SAME height before the tracker treats
// the node as unrecoverably desynced (pruned past our cursor, or a permanent
// missing-block fault) and fails loud instead of retrying every 3s forever.
// Generous by design so ordinary node restarts / transient RPC blips still
// self-heal: at a 3s backoff this is ~1 minute of retrying before giving up.
// Override via XCHAIN_MAX_BLOCK_FETCH_RETRIES for slow-recovering nodes.
const BLOCK_FETCH_RETRY_SLEEP_MS = 3000
const MAX_BLOCK_FETCH_RETRIES = Number(process.env.XCHAIN_MAX_BLOCK_FETCH_RETRIES) > 0
    ? Number(process.env.XCHAIN_MAX_BLOCK_FETCH_RETRIES)
    : 20
// After this many consecutive fetch failures at one height on an AuxPoW chain,
// treat the failure as deterministic (e.g. an AuxPoW section skipAuxPow cannot
// traverse) and switch to getBlockReassembled, which
// rebuilds the pure block from getblockheader + verbose getblock + per-txid
// getrawtransaction and so never reads the AuxPoW bytes at all. Must stay well
// below MAX_BLOCK_FETCH_RETRIES so the fallback gets attempts in before the
// streak is misdiagnosed as a pruned-node desync and halts the tracker.
const AUXPOW_REASSEMBLE_AFTER = 5
const REMOVE_SPENT = true
// Coinbase outputs are unspendable until they reach this many confirmations
// (consensus rule: 100 on BTC/LTC/DOGE and their regtest/testnet variants).
// Serving immature coinbase as spendable hands a caller an input that
// every node will reject, so getUtxosAddress withholds coinbase outputs below
// this depth. Overridable for test harnesses that mine short chains.
const COINBASE_MATURITY = Number(process.env.XCHAIN_COINBASE_MATURITY) > 0
    ? Number(process.env.XCHAIN_COINBASE_MATURITY)
    : 100
const ETA_WINDOW_BLOCKS = 1000 //Rolling window size for ETA calculation
const MIN_VERIFICATION_PROGRESS_TO_PARSE = 0.99 //How much progress the node need to have to start parsing

// Hard ceiling on how many outputs a single-address query will materialize. A
// mega miner-coinbase/payout address can hold millions of UTXOs; loading them all
// into one array OOMs the process and takes the tracker down for every caller.
// Above this ceiling, unbounded queries (get_utxos / get_balance with no page
// limit) fail loud (HTTP 413) so callers page via /utxos?limit=&after= instead.
// Tune per host via UTXO_MAX_ADDRESS_OUTPUTS.
const MAX_ADDRESS_OUTPUTS = Number(process.env.UTXO_MAX_ADDRESS_OUTPUTS) > 0
    ? Math.floor(Number(process.env.UTXO_MAX_ADDRESS_OUTPUTS))
    : 500000

// Per-chain reorg recovery window (Tier B, 2026-06-02): how many recent blocks of
// spent-output recovery records (K/M entries) are retained, and therefore the
// deepest reorg the tracker can auto-recover from before a manual resync is
// required. Sized larger on the faster / lower-hashpower chains so the window
// stays comfortably above that chain's cross-chain confirmation gate (an ordinary
// reorg inside the trust window is auto-recovered, never a manual resync). On
// 1-minute DOGE blocks the old flat value of 10 was only ~10 minutes of headroom.
// Single-sourced in undo-blocks.js so the live worker and the bulk seeder can never drift.
const { DEFAULT_UNDO_BLOCKS, FALLBACK_UNDO_BLOCKS, MAX_SAFE_UNDO_BLOCKS, coinFromNetwork, resolveUndoBlocks } = require('./undo-blocks.js')

// Per-coin block/tx wire-serialization family from the canonical coin registry
// (src/coins). Used to gate AuxPoW stripping on the coin's declared wireFormat
// ('auxpow') instead of a coin-name literal.
const { WIRE_FORMAT } = require('./coins')

// coinFromNetwork and resolveUndoBlocks are single-sourced in undo-blocks.js
// (imported above) so the live worker, seeder, orchestrator, and api.js share
// one env-override resolution semantics and can never drift (uuid:65309b82).
const PREFETCH_SIZE = 10 //Number of blocks to pre-fetch concurrently while processing the current one

// Single-byte key used to persist pendingKMCleanup across restarts.
// 0x50 ('P') is unused by LevelUpDb's key schema (B/T/I/O/H/J/S/Z/K/M/N/W).
const P_PENDING_CLEANUP_KEY = Buffer.from([0x50])

class XChainUtxoTracker {
    static parseOutBuckets = { hash: 0, ins: 0, sb: 0 }

    constructor(network, nodeUrl, nodePort, nodeUser, nodePassword, dbName, auxPow) {
      this.network = CryptoNetworks.getBitcoinJsNetwork(network)
      // getBitcoinJsNetwork returns undefined for an unrecognized coin/network
      // name (e.g. a typo in the NETWORK env var). Left unguarded, bitcoinjs-lib
      // silently defaults an undefined network to BTC mainnet at address/script
      // decode time, so a misconfiguration would run under the wrong network
      // parameters instead of failing. Fail loud at construction instead.
      if (!this.network) {
        throw new Error(`XChainUtxoTracker: unknown network "${network}" -- no bitcoinjs network config resolved. Check the configured network name.`)
      }
      this.connector = new BlockchainConnector(nodeUrl, nodePort, nodeUser, nodePassword)
      this.dbName = dbName
      
      this.db = null
      this.mempoolDb = null
      
      this.parseMode = PARSE_MODE_BULK_INSERTS
      this.xchainBlockDecoder = new XChainBlockDecoder(network)
      
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
      // The answer comes from the coin's declared wireFormat in the
      // canonical registry (src/coins) rather than a coin-name literal, matching the
      // decoder and the bulk seeder (bulk-sync/dump.js), so onboarding a merge-mined
      // chain is a registry edit. LTC's MWEB handling is unaffected: that is the
      // 'mweb' wireFormat branch inside XChainBlockDecoder, not this fetch path. The
      // `auxPow` parameter is retained for call-site stability and is deliberately no
      // longer consulted.
      this.auxPow = WIRE_FORMAT[coinFromNetwork(network)] === 'auxpow'
      this.undoBlocks = resolveUndoBlocks(network)
      this.lastBlocks = []
      
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

      // Set when the polling loop leaves by THROWING (the halt path) rather than
      // through its normal-stop branch, which is the only branch that closes the
      // store and sets parsingStopped. Tracked separately from `halted` because
      // `halted` is an operator-facing status that deliberately outlives a
      // relaunch, while this records the loop-lifecycle fact stopParsing acts on.
      this.parsingAborted = false

      // Coinbase maturity depth used by getUtxosAddress to withhold immature
      // coinbase outputs. Instance-scoped (not a bare const) so test
      // harnesses that mine short chains can relax it; production keeps the
      // consensus default. Setting it to 0 disables the gate.
      this.coinbaseMaturity = COINBASE_MATURITY
    }
    
    async addToLastBlocks(blockHash){
        this.lastBlocks.push(blockHash)
        await this.db.addLastStoredBlock(blockHash)

        while (this.lastBlocks.length > this.undoBlocks){
            let nextBlockHash = this.lastBlocks.shift()

            // Outputs created & spent within the same batch are discarded from in-memory deletions.
            // On-disk K/M cleanup is deferred to after the batch is committed via cleanupAgedBlocks().
            if (this.db.deletedTransactionArray && this.db.deletedTransactionArray.has(nextBlockHash)){
                this.db.deletedTransactionArray.delete(nextBlockHash)
            }

            this.pendingKMCleanup.push(nextBlockHash)
        }
    }

    async cleanupAgedBlocks(){
        // Called after endTransaction() so K/M entries are committed to disk and can be found
        if (this.pendingKMCleanup.length === 0) return

        // Never purge recovery records for a block that is still inside the live
        // reorg window (this.lastBlocks). Aging normally only shifts a hash into
        // pendingKMCleanup AFTER it leaves the window, so this is a no-op on the
        // happy path. But when an in-flight batch is discarded (mid-batch reorg),
        // pendingKMCleanup was populated against the STALE in-memory window that
        // still counted the now-discarded staged blocks, so it can contain hashes
        // that are once again the live committed tip after lastBlocks is reloaded
        // from disk. Purging those would delete K/M/W/N records (including the
        // tip's own N record) inside the undo window, so the very next reorg
        // reloads an empty/short N index and wedges verifyReorg into a crash-loop.
        // A hash skipped here is simply re-queued by addToLastBlocks when it later
        // ages out for real, so dropping it now loses nothing. Dedupe as well:
        // P-key crash-recovery can replay a list that addToLastBlocks then
        // re-shifts, yielding the same hash twice in one transaction.
        const liveWindow = new Set(this.lastBlocks)
        const seen = new Set()
        const toClean = []
        for (const blockHash of this.pendingKMCleanup){
            if (liveWindow.has(blockHash)) continue
            if (seen.has(blockHash)) continue
            seen.add(blockHash)
            toClean.push(blockHash)
        }

        await this.db.beginTransaction()

        for (let blockHash of toClean){
            await this.db.processDeletedOutputs(blockHash, false)
            await this.db.removeLastStoredBlock(blockHash)
            // Prune the W creation-block reverse-index too. It is only read by the
            // reorg unwind (removeCreatedOutputsInBlock), which can never reach past
            // the undoBlocks window, so once a block ages out of that window its W
            // records are dead weight; without this the W index grows with every
            // output ever created instead of the live-UTXO set.
            await this.db.removeCreatedOutputsBlockIndexOnly(blockHash)
            // Same rationale for the Z block->script reverse-index: its only
            // reader is the reorg unwind (removeOutputScriptsInBlock), which is
            // depth-guarded to the undoBlocks window, so an aged-out block's Z
            // records are unreachable dead weight (one per first-seen script,
            // growing forever). S (first-seen) is deliberately left intact - it
            // backs the live getFirstSeen query.
            await this.db.removeOutputScriptsBlockIndexOnly(blockHash)
        }

        // Remove the crash-recovery marker atomically with the cleanup writes so
        // a crash here causes a harmless idempotent re-run on the next restart.
        await this.db.addTransaction("del", P_PENDING_CLEANUP_KEY)

        await this.db.endTransaction()
        this.pendingKMCleanup = []
    }

    // Discard an in-flight (uncommitted) LevelDB batch before reorg recovery.
    // A periodic blockchain-info refresh can land in the true tip
    // regression branch of start() mid-batch, while an open transaction still
    // holds staged writes for blocks recovery is about to roll back. verifyReorg
    // opens its OWN transaction, so a retained stale batch either strands phantom
    // UTXOs (committed at the next flush) or, once verifyReorg nulls
    // transactionArray, routes later writes as unbatched direct puts while the
    // batch counter stays > 0, breaking per-block atomicity. Rolling the batch
    // back drops the P-key write that records aged-out blocks awaiting K/M
    // cleanup, so persist that list out-of-band (standalone put, deliberately
    // outside the rolled-back batch) so restart recovery still runs it. Returns
    // true when a batch was discarded; the caller then zeroes its batch counters.
    async discardInflightBatchForReorg(blocksQuantity){
        if (blocksQuantity <= 0) return false
        await this.db.endTransaction(false)
        if (this.pendingKMCleanup.length > 0) {
            await this.db.db.put(P_PENDING_CLEANUP_KEY,
                Buffer.from(JSON.stringify(this.pendingKMCleanup)))
        }
        this.pendingKMCleanup = []
        return true
    }

    // Evaluate a block-fetch failure at `height`. `streakHeight`/`streakCount`
    // are the caller's running streak; the count increments while the SAME height
    // keeps failing and resets to 1 on a height change (we advanced past the stuck
    // block). Once MAX_BLOCK_FETCH_RETRIES consecutive failures accrue at one
    // height, the node cannot serve that block (pruned past our cursor, or a
    // permanent missing-block fault): record a diagnosable desync state on the
    // instance (surfaced by get_sync_status) and THROW so the polling loop's
    // top-level guard logs [fatal] and exits for a supervised restart, instead of
    // retrying every few seconds forever with no signal. Returns the updated
    // { height, count } streak for the caller to carry forward on a non-fatal miss.
    // Decides whether the block-fetch loop should stop retrying the AuxPoW strip
    // path for this height and rebuild the block per-tx instead (a failure streak
    // this long at ONE height on an AuxPoW chain reads as deterministic, e.g. an
    // AuxPoW section skipAuxPow cannot traverse, not a transient RPC blip).
    shouldReassembleBlock(height, streakHeight, streakCount){
        return !!this.auxPow && streakHeight === height && streakCount >= AUXPOW_REASSEMBLE_AFTER
    }

    noteBlockFetchFailure(height, streakHeight, streakCount, error){
        const count = (streakHeight === height) ? streakCount + 1 : 1
        const msg = error && error.message ? error.message : String(error)
        console.error('Error fetching block at height ' + height + ' (attempt ' + count + '/' + MAX_BLOCK_FETCH_RETRIES + '): ' + msg, error)
        if (count >= MAX_BLOCK_FETCH_RETRIES){
            this.blockFetchDesync = {
                height: height,
                failures: count,
                lastError: msg,
                detectedAt: Date.now()
            }
            throw new Error("Block-fetch desync: the node failed to serve block " +
                height + " after " + count + " consecutive attempts. " +
                "The node is likely pruned past this height or permanently missing the block. " +
                "Last error: " + msg + ". " +
                "Recovery: point at a non-pruned node, or resync from a known-good snapshot.")
        }
        return { height: height, count: count }
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

    async removeFromLastBlocks(blockHash){
        // Guard against the empty-list edge case: when lastBlocks is empty,
        // indexOf returns -1 and length-1 is also -1, making the condition
        // true and silently pop()-ing undefined instead of throwing. An empty
        // list means we have rolled back past the tracked window, which is an
        // error that should abort rather than silently corrupt state.
        if (this.lastBlocks.length === 0){
            throw XChainUtxoTracker.markUnrecoverableReorg(new Error("Can't delete a block from 'last blocks': list is empty (reorg exceeds tracked window)"))
        }
        if (this.lastBlocks.indexOf(blockHash) == this.lastBlocks.length-1){
            this.lastBlocks.pop()
            await this.db.removeLastStoredBlock(blockHash)
        } else {
            throw new Error("Can't delete a block from the 'last blocks' if it's not the last one")
        }
    }

    // Enter a stable halted state instead of exiting on an unrecoverable reorg.
    // Exiting lets Docker's restart policy relaunch us into the identical failure
    // every ~15s forever (the observed 5000+ restart crash-loop). Halting keeps
    // the process up so /status reports 503 (unhealthy, not falsely healthy) and
    // get_sync_status carries the reason, and the operator can run restorebootstrap
    // against a process that is not restarting under them. The tracker does NOT
    // auto-wipe: rebuilding the UTXO set needs a resync from a known-good snapshot,
    // an operator decision. Called from api.js's top-level start() guard.
    haltForResync(reason){
        this.halted = true
        this.haltReason = reason || 'unrecoverable reorg (rolled back past the recovery window)'
        // We are only ever called from the start() rejection guard, so the loop is
        // provably gone and skipped the normal-stop branch that sets parsingStopped.
        // Record that: without it stopParsing() can only time out, and both recovery
        // RPCs open with that wait, so the resync this halt exists to enable is
        // unreachable on the one state that needs it.
        this.parsingAborted = true
        if (this.mempoolInterval){ clearInterval(this.mempoolInterval); this.mempoolInterval = null }
        console.error('[halted] xchain-utxo-tracker stopped polling: ' + this.haltReason
            + ' - process kept alive for an operator resync (restorebootstrap); NOT auto-wiping. '
            + '/status now returns 503 and get_sync_status.halted=true.')
    }

    // Clear the halt marker once a restore has REPLACED the on-disk store the halt was
    // declared against, so /status and get_sync_status stop reporting a fault that no
    // longer describes the data and xchain-node's BootstrapHealthGate can accept this
    // source again. Deliberately not called from start() or from the snapshot-only
    // getbootstrap relaunch: there the data is unchanged, so an un-halt would publish
    // healthy over the same bad tip until the loop re-detects the reorg, and the gate's
    // lag budget cannot catch that window because a deep reorg leaves lag near zero.
    // A restored snapshot that is itself bad simply re-halts when the loop re-detects.
    clearHalt(){
        this.halted = false
        this.haltReason = null
    }

    // getLastStoredBlocks() returns the stored-block hashes in blockHash
    // (lexicographic) order, but the reorg path (removeFromLastBlocks) requires
    // lastBlocks to be in ascending HEIGHT order with the chain tip last.
    // Without sorting, a reorg throws "Can't delete a block from the 'last
    // blocks'…" and wedges the sync loop. Each block's height comes from its
    // B-prefix record; this is at most UNDO_BLOCKS lookups (per-chain
    // DEFAULT_UNDO_BLOCKS, e.g. BTC=12/LTC=48/DOGE=120, not a fixed 10).
    async loadLastBlocksSortedByHeight(){
        const storedHashes = await this.db.getLastStoredBlocks()
        const withHeight = []
        for (const hash of storedHashes){
            const blk = await this.db.getBlock(hash)
            withHeight.push({ hash, height: blk ? blk.h : -1 })
        }
        withHeight.sort((a, b) => a.height - b.height)
        return withHeight.map(b => b.hash)
    }

    async sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    
    millisecondsToTimeString(ms){
        var milliseconds = Math.floor((ms % 1000) / 100),
        seconds = Math.floor((ms / 1000) % 60),
        minutes = Math.floor((ms / (1000 * 60)) % 60),
        hours = Math.floor((ms / (1000 * 60 * 60)) % 24),
        days = Math.floor(ms / (1000 * 60 * 60 * 24));

        hours = (hours < 10) ? "0" + hours : hours;
        minutes = (minutes < 10) ? "0" + minutes : minutes;
        seconds = (seconds < 10) ? "0" + seconds : seconds;

        let result = hours + "h" + minutes + "m" + seconds + "." + milliseconds+"s";
        if (days > 0) result = days + "d " + result;
        return result;
    }
    
    isSynced(){
        return this.synced
    }

    // True once the mempool has reconverged at least once since the last
    // synced=true transition. Pairs with isSynced() to form the readiness signal:
    // synced alone can be true while the mempool DB is still empty/repopulating.
    isMempoolReconverged(){
        return this.mempoolReconverged
    }
    
    async stopParsing(){
        return new Promise(async(resolve, reject) => {
            this.keepParsing = false

            if (this.mempoolInterval) {
                clearInterval(this.mempoolInterval)
                this.mempoolInterval = null
            }

            // The loop aborted (halt path) instead of stopping normally, so nothing
            // is left running to reach the else branch and the wait below could only
            // ever time out and reject, which is what made restorebootstrap and
            // getbootstrap unreachable on a halted tracker. Finalize the stop here
            // the way that branch would, closing the store FIRST so a restore wipes
            // /data with no handle held open. parsingStopped is the idempotence guard:
            // a second stop call falls through to the resolve path below.
            if (this.parsingAborted && !this.parsingStopped){
                try {
                    await this.db.close()
                } catch (err) {
                    // Reject explicitly: a throw inside this executor never reaches the
                    // caller's await, it becomes an unhandled rejection and the RPC hangs.
                    reject(err)
                    return
                }
                this.parsingStopped = true
                resolve(true)
                return
            }

            let triesCount = 10

            while((!this.parsingStopped) && (triesCount > 0)){
                await this.sleep(1000)
                triesCount = triesCount - 1
            }

            if ((triesCount == 0) && (!this.parsingStopped)){
                // The block loop did not reach its keepParsing check within the
                // budget (parked in a 200-block commit or the multi-batch mempool
                // wait). If we reject and leave keepParsing=false, the loop takes
                // its else branch the moment it next checks, closes the LevelDB, and
                // sets parsingStopped=true, so start() resolves and launchTracker's
                // .catch never relaunches: every query then 500s on a closed store
                // with no process exit for a restart policy to catch. A failed stop
                // must be a no-op that leaves the tracker running: restore
                // keepParsing so the loop continues, and re-arm the mempool poller
                // (the loop also re-arms it once synced, but do it here in case the
                // loop is parked in the synced branch's sleep).
                this.keepParsing = true
                if (this.mempoolInterval == null){
                    this.mempoolInterval = setInterval(this.updateMempool.bind(this), MEMPOOL_INTERVAL)
                }
                reject(new Error("There was an error trying to stop the parsing"))
            } else {
                resolve(true)
            }
        })
    }
    
    getAddressType(address, network) {
        try {
            bitcoin.payments.p2pkh({ address, network })
            return 'p2pkh'
        } catch (e) {}

        try {
            bitcoin.payments.p2sh({ address, network });
            return 'p2sh'
        } catch (e) {}

        try {
            bitcoin.payments.p2wpkh({ address, network });
            return 'p2wpkh'
        } catch (e) {}

        try {
            bitcoin.payments.p2tr({ address, network });
            return 'p2tr';
        } catch (e) {}

        return "unknown"
    }
    
    async getBalanceInfo(address){
        let script = bitcoin.address.toOutputScript(address, this.network)
        let scriptHash = createHash('sha256').update(script).digest('hex')

        let confirmedBalance = 0n
        let pendingBalance = 0n
        let utxosConfirmed = 0
        let utxosPending = 0
        let totalReceived = 0n

        let confirmedOutputs = await this.db.getOutputsScriptPubKey(scriptHash, { maxOutputs: MAX_ADDRESS_OUTPUTS })
        let mempoolOutputs = await this.mempoolDb.getOutputsScriptPubKey(scriptHash, { maxOutputs: MAX_ADDRESS_OUTPUTS })

        // Outpoints already accounted from the confirmed store. A just-mined tx
        // lives in both stores until the deferred mempool cleanup runs, so the
        // mempool loop must skip any outpoint already counted here or the same
        // coin is double-listed (inflating the reported balance).
        const confirmedKeys = new Set()

        for (let nextOutput of confirmedOutputs) {
            let txid = nextOutput.fullTxid || nextOutput.txid

            // Same fail-loud guard as getUtxosAddress: a 16-char fallback means
            // the O-record predates the fullTxHash field. get_utxos already throws
            // here; get_info must too, or a pre-format DB silently returns balances
            // while every spend path errors, masking the need for a re-index.
            if (txid.length !== 64) {
                throw new Error(
                    `UTXO record is missing a fullTxHash (got ${txid.length}-char key prefix instead of a 64-char txid).` +
                    ` This record predates the O-record fullTxHash field; re-index this LevelDB before use.` +
                    ` UTXO key: ${nextOutput.txid}`
                )
            }

            confirmedKeys.add(txid + ':' + nextOutput.vout)

            let amount = BigInt(nextOutput.value)

            // Note: with REMOVE_SPENT=true, totalReceived only reflects currently unspent confirmed outputs
            totalReceived += amount

            // getInput keys on the 8-byte (16-hex) txid prefix, matching insertInput.
            let mempoolInput = await this.mempoolDb.getInput(txid.substring(0, 16), nextOutput.vout)
            if (mempoolInput != null) {
                // Confirmed output being spent in the mempool: counts as confirmed but pending out
                confirmedBalance += amount
                pendingBalance -= amount
                utxosConfirmed++
            } else {
                confirmedBalance += amount
                utxosConfirmed++
            }
        }

        for (let nextOutput of mempoolOutputs) {
            let txid = nextOutput.fullTxid || nextOutput.txid

            // See the confirmed-output loop above: a 16-char fallback means the
            // O-record predates the fullTxHash field and can never spend validly.
            if (txid.length !== 64) {
                throw new Error(
                    `UTXO record is missing a fullTxHash (got ${txid.length}-char key prefix instead of a 64-char txid).` +
                    ` This record predates the O-record fullTxHash field; re-index this LevelDB before use.` +
                    ` UTXO key: ${nextOutput.txid}`
                )
            }

            // Skip an outpoint already counted from the confirmed store (just-mined
            // tx still present in both stores during the cleanup window).
            if (confirmedKeys.has(txid + ':' + nextOutput.vout)) continue

            let mempoolInput = await this.mempoolDb.getInput(txid.substring(0, 16), nextOutput.vout)
            if (mempoolInput == null) {
                pendingBalance += BigInt(nextOutput.value)
                utxosPending++
            }
        }

        return {
            "address": address,
            "type": this.getAddressType(address, this.network),
            "balances": {
                "confirmed": satoshiToDecimalString(confirmedBalance),
                "pending": satoshiToDecimalString(pendingBalance),
                "received": satoshiToDecimalString(totalReceived)
            },
            "utxos": {
                "confirmed": utxosConfirmed,
                "pending": utxosPending
            }
        }
    }
    
    async getUtxosAddress(address, { limit = null, after = null } = {}){
        let script = bitcoin.address.toOutputScript(address, this.network)
        let scriptHash = createHash('sha256').update(script).digest('hex')
        let scriptPubKeyHex = util.uint8ArrayToHex(script)

        const paged = Number.isFinite(limit) && limit > 0
        const pageLimit = paged ? Math.floor(limit) : null

        // Paged mode pulls one bounded page of confirmed outputs (resuming from
        // `after`); unbounded mode pulls everything but is capped by the
        // MAX_ADDRESS_OUTPUTS safety ceiling.
        let confirmedOutputs = await this.db.getOutputsScriptPubKey(scriptHash, paged
            ? { limit: pageLimit, after }
            : { maxOutputs: MAX_ADDRESS_OUTPUTS })

        // Continuation cursor for the next page, captured BEFORE the loop below
        // rewrites each output's `txid` to the full hash. The cursor is the last
        // *scanned* confirmed DB key (txHash8:vout), independent of mempool-spend
        // filtering, so the next page resumes with no gaps or repeats. Only set
        // when a full page was read (more rows may remain).
        const nextCursor = (paged && confirmedOutputs.length === pageLimit)
            ? confirmedOutputs[confirmedOutputs.length - 1].txid + ':' + confirmedOutputs[confirmedOutputs.length - 1].vout
            : null

        // Mempool outputs are unpaginated (the mempool set is small and bounded).
        // In paged mode include them only on the first page (after == null) so they
        // are not duplicated across pages.
        let mempoolOutputs = (!paged || after == null)
            ? await this.mempoolDb.getOutputsScriptPubKey(scriptHash, { maxOutputs: MAX_ADDRESS_OUTPUTS })
            : []

        let results = []

        // Outpoints emitted from the confirmed store, so the mempool loop can skip
        // a just-mined tx that still lives in both stores during the deferred
        // cleanup window (otherwise the same outpoint is returned twice, handing
        // the encoder a duplicate input).
        const confirmedKeys = new Set()

        for (let nextOutput of confirmedOutputs) {
            let txid = nextOutput.fullTxid || nextOutput.txid

            // A valid txid is the full 32-byte hash (64 hex chars). When fullTxid
            // is null the fallback yields the 8-byte O-key prefix (16 hex chars),
            // which happens only for O-records written before the full hash was
            // added to the O-record format. Such a record can never produce a
            // valid spend, so fail loudly here rather than letting the truncated
            // id silently corrupt a downstream PSBT. Re-index this LevelDB.
            if (txid.length !== 64) {
                throw new Error(
                    `UTXO record is missing a fullTxHash (got ${txid.length}-char key prefix instead of a 64-char txid).` +
                    ` This record predates the O-record fullTxHash field; re-index this LevelDB before use.` +
                    ` UTXO key: ${nextOutput.txid}`
                )
            }

            confirmedKeys.add(txid + ':' + nextOutput.vout)

            // Skip confirmed outputs being spent in the mempool. getInput keys on
            // the 8-byte (16-hex) txid prefix, matching insertInput.
            let mempoolInput = await this.mempoolDb.getInput(txid.substring(0, 16), nextOutput.vout)
            if (mempoolInput != null) continue

            const confirmations = this.blockchainInfoLastBlock - nextOutput.height + 1

            // Withhold an output whose count came out NEGATIVE. blockchainInfoLastBlock
            // is -1 both in the constructor and again at the top of every startTracking
            // run, so until the first getblockchaininfo lands this subtraction is
            // negative for every stored output. The consumer contract is non-negative:
            // xchain-encoder validator.js validateUtxoEntry and UtxoTracker.js both
            // throw `confirmations must be a non-negative integer`, and that throw
            // aborts the WHOLE address fetch, not just the one entry. Zero is
            // deliberately still served: it is the encoder's unconfirmed marker
            // (`confirmations == 0`) and the pinned stale-tip behaviour in
            // test/boundary/confirmations.test.js, so only the value that would throw
            // is dropped.
            if (confirmations < 0) continue

            // Withhold immature coinbase outputs: every node rejects a spend
            // of a coinbase output below coinbaseMaturity confirmations, so serving
            // it as spendable would hand a caller an input that can never confirm.
            // Legacy O-records carry coinbase=false and are unaffected. Coinbase
            // outputs only exist in the confirmed store, so no equivalent filter is
            // needed on the mempool loop below.
            if (nextOutput.coinbase && this.coinbaseMaturity > 0 && confirmations < this.coinbaseMaturity) continue

            nextOutput.txid = txid
            nextOutput.confirmations = confirmations
            nextOutput.amount = satoshiToDecimalString(nextOutput.value)
            nextOutput.scriptPubKey = scriptPubKeyHex
            results.push(nextOutput)
        }

        for (let nextOutput of mempoolOutputs) {
            let txid = nextOutput.fullTxid || nextOutput.txid

            // See the confirmed-output loop above: a 16-char fallback means the
            // O-record predates the fullTxHash field and can never spend validly.
            if (txid.length !== 64) {
                throw new Error(
                    `UTXO record is missing a fullTxHash (got ${txid.length}-char key prefix instead of a 64-char txid).` +
                    ` This record predates the O-record fullTxHash field; re-index this LevelDB before use.` +
                    ` UTXO key: ${nextOutput.txid}`
                )
            }

            // Skip an outpoint already emitted from the confirmed store (just-mined
            // tx still present in both stores during the cleanup window). confirmedKeys
            // is a fast path but only holds THIS page's confirmed rows: in paged mode
            // the confirmed twin of a both-stores outpoint can sit on a later page, so
            // the page-scoped set misses it and the same outpoint would be returned
            // twice across pages (handing the encoder a duplicate input). Fall back to
            // a point-probe of the confirmed store's live H record, which is page
            // independent, so the outpoint is emitted only from the confirmed store.
            if (confirmedKeys.has(txid + ':' + nextOutput.vout)) continue
            if (paged && await this.db.hasOutputForTx(txid.substring(0, 16), nextOutput.vout)) continue

            // Skip mempool outputs that are also spent by another mempool tx
            let mempoolInput = await this.mempoolDb.getInput(txid.substring(0, 16), nextOutput.vout)
            if (mempoolInput != null) continue

            nextOutput.txid = txid
            nextOutput.height = null
            nextOutput.confirmations = 0
            nextOutput.amount = satoshiToDecimalString(nextOutput.value)
            nextOutput.scriptPubKey = scriptPubKeyHex
            results.push(nextOutput)
        }

        // Expose the continuation cursor as a non-enumerable property so the array
        // still serializes as a bare UTXO list (preserving the existing API/JSON-RPC
        // contract) while the REST layer can read it for the X-Next-Cursor header.
        if (paged) Object.defineProperty(results, 'nextCursor', { value: nextCursor, enumerable: false })

        return results
    }

    async getFirstSeen(address){
        const script = bitcoin.address.toOutputScript(address, this.network)
        const scriptHash = createHash('sha256').update(script).digest('hex')

        const record = await this.db.getOutputScriptBlock(scriptHash)
        if (!record) return null

        return { height: record.h }
    }
    
    async parseTransaction(db, transaction, blockHash, blockHeight = -1, addHints = false, removeSpent = false){
        let nextTxId = null
        if ("id" in transaction){ //Some transactions are changed for bitcoinjs-lib to parse them. The original hash of the transaction get stored in the "id" property
            nextTxId = transaction["id"]
        } else {
            nextTxId = transaction.getId()
        }
        
        let nextTxId8 = nextTxId.substring(0,16)
    
        let resultInfo = {
            inputsCount: 0,
            outputsCount: 0
        }

        const isCoinbase = XChainUtxoTracker.isCoinbaseTransaction(transaction)

        if (!removeSpent) {
            await db.insertTransaction({hash:nextTxId, blockHash:blockHash})
        }

        // Process all inputs concurrently (each input has its own hash buffer so
        // the in-place .reverse() calls don't interfere between parallel closures
        const inputCounts = await Promise.all(transaction.ins.map(async (nextInput) => {
            const standardInput = ("standard_input" in nextInput ? nextInput["standard_input"] : true)

            if ((nextInput.index === 4294967295) || !standardInput) { //4294967295 = 0xFFFFFFFF. It's a Coinbase input, there's no need to trace it
                return 0
            }

            // Reverse the wire-order (little-endian) hash to big-endian display
            // order on a COPY of the buffer. .reverse() mutates in place, and
            // nextInput.hash is shared: the same decoded tx can be parsed again
            // on a later path (e.g. mempool ingest, then block confirmation).
            // Mutating it here would (a) double-reverse within this call,
            // corrupting the hint record's prevTxHash, and (b) leave the buffer
            // flipped for the downstream re-parse, breaking its spend lookup.
            // Buffer.from() copies, so the source bytes stay untouched and the
            // same hex feeds insertInput, the hint, and the removeSpent lookup.
            const prevTxHashHex = util.uint8ArrayToHex(Buffer.from(nextInput.hash).reverse())

            if (removeSpent){
                let prevTxHash8 = prevTxHashHex.substring(0, 16)
                await db.removeOutputWithInput({prevTxHash:prevTxHash8, prevOutputIndex:nextInput.index, blockHash:blockHash})
            } else {
                await db.insertInput({
                    prevTxHash:prevTxHashHex,
                    prevOutputIndex:nextInput.index,
                    txHash:nextTxId8
                })
            }

            if (addHints){
                await db.insertInputHint({
                    prevTxHash:prevTxHashHex,
                    prevOutputIndex:nextInput.index,
                    txHash:nextTxId8
                })
            }

            return 1
        }))

        // Process all outputs concurrently (each output is fully independent
        await Promise.all(transaction.outs.map(async (nextOutput, txOutputIndex) => {
            const scriptHash = createHash('sha256').update(nextOutput.script).digest('hex')

            await db.insertOutput({scriptPubKey:scriptHash, txHash:nextTxId8, outputIndex:txOutputIndex, value:nextOutput.value, height:blockHeight, fullTxHash:nextTxId, coinbase:isCoinbase})

            if (addHints || removeSpent){
                await db.insertOutputHint({scriptPubKey:scriptHash, txHash:nextTxId8, outputIndex:txOutputIndex})
                await db.insertOutputScriptBlock(scriptHash, blockHash, blockHeight)
                await db.insertOutputBlock({scriptPubKey:scriptHash, txHash:nextTxId8, outputIndex:txOutputIndex, blockHash})
            }
        }))

        resultInfo["inputsCount"]  = inputCounts.reduce((acc, n) => acc + n, 0)
        resultInfo["outputsCount"] = transaction.outs.length

        return resultInfo
    }
    
    // A coinbase transaction is the block's generation tx: exactly one input
    // whose prevout index is 0xFFFFFFFF (the same marker the input passes use to
    // skip tracing it). Its outputs are unspendable until COINBASE_MATURITY
    // confirmations, so they must be marked at insert time.
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
    //     is itself the signal.
    static computeFreshness(committedHeight, nodeTip, synced, state = {}){
        const { mempoolReconverged = false, halted = false, haltReason = null } = state
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
            freshness.halted      = true
            freshness.halt_reason = haltReason
        }
        return freshness
    }

    static isCoinbaseTransaction(transaction){
        return Array.isArray(transaction.ins) && transaction.ins.length === 1
            && transaction.ins[0] && transaction.ins[0].index === 4294967295
    }

    // Pass 1 of two-pass block processing: insert all outputs (and the tx record).
    // Must complete for ALL transactions before parseTxInputs runs, so that
    // removeOutputWithInput can find same-block outputs in transactionArray.
    async parseTxOutputs(db, transaction, blockHash, blockHeight, addHints, removeSpent){
        const nextTxId  = "id" in transaction ? transaction["id"] : transaction.getId()
        const nextTxId8 = nextTxId.substring(0, 16)
        const isCoinbase = XChainUtxoTracker.isCoinbaseTransaction(transaction)
        const _tt = XChainUtxoTracker.parseOutBuckets

        if (!removeSpent) {
            await db.insertTransaction({hash: nextTxId, blockHash: blockHash})
        }

        // Sequential in vout order so that insertOutputScriptBlock writes the
        // S-record for the first (smallest vout) occurrence of a scriptHash:
        // matching bulk-sync's block-tx-vout-ordered dedup. Concurrent Promise.all
        // here raced, producing non-deterministic S-record winners.
        for (let txOutputIndex = 0; txOutputIndex < transaction.outs.length; txOutputIndex++) {
            const nextOutput = transaction.outs[txOutputIndex]
            const _h0 = DEBUG_TRACE ? Date.now() : 0
            // Keep the hash as a Buffer: insertOutput / insertOutputHint /
            // insertOutputScriptBlock all accept Buffers and use buf.copy()
            // instead of decoding a hex string back into bytes.
            const scriptHash = createHash('sha256').update(nextOutput.script).digest()
            if (DEBUG_TRACE) _tt.hash += Date.now() - _h0

            const _i0 = DEBUG_TRACE ? Date.now() : 0
            await db.insertOutput({scriptPubKey: scriptHash, txHash: nextTxId8, outputIndex: txOutputIndex, value: nextOutput.value, height: blockHeight, fullTxHash: nextTxId, coinbase: isCoinbase})
            if (DEBUG_TRACE) _tt.ins += Date.now() - _i0

            if (addHints || removeSpent) {
                const _i1 = DEBUG_TRACE ? Date.now() : 0
                await db.insertOutputHint({scriptPubKey: scriptHash, txHash: nextTxId8, outputIndex: txOutputIndex})
                if (DEBUG_TRACE) _tt.ins += Date.now() - _i1

                const _s0 = DEBUG_TRACE ? Date.now() : 0
                await db.insertOutputScriptBlock(scriptHash, blockHash, blockHeight)
                if (DEBUG_TRACE) _tt.sb += Date.now() - _s0

                await db.insertOutputBlock({scriptPubKey: scriptHash, txHash: nextTxId8, outputIndex: txOutputIndex, blockHash})
            }
        }

        return transaction.outs.length
    }

    // Pass 2 of two-pass block processing: process all inputs.
    // By the time this runs, all same-block outputs are already in transactionArray,
    // so removeOutputWithInput will resolve intra-block spends correctly.
    async parseTxInputs(db, transaction, blockHash, addHints, removeSpent){
        const nextTxId  = "id" in transaction ? transaction["id"] : transaction.getId()
        const nextTxId8 = nextTxId.substring(0, 16)

        const inputCounts = await Promise.all(transaction.ins.map(async (nextInput) => {
            const standardInput = ("standard_input" in nextInput ? nextInput["standard_input"] : true)

            if ((nextInput.index === 4294967295) || !standardInput) { //4294967295 = 0xFFFFFFFF. It's a Coinbase input, there's no need to trace it
                return 0
            }

            // Reverse the wire-order (little-endian) hash to big-endian display
            // order on a COPY of the buffer. .reverse() mutates in place, and
            // nextInput.hash is shared: the same decoded tx can be parsed again
            // on a later path (e.g. mempool ingest, then block confirmation).
            // Mutating it here would (a) double-reverse within this call,
            // corrupting the hint record's prevTxHash, and (b) leave the buffer
            // flipped for the downstream re-parse, breaking its spend lookup.
            // Buffer.from() copies, so the source bytes stay untouched and the
            // same hex feeds insertInput, the hint, and the removeSpent lookup.
            const prevTxHashHex = util.uint8ArrayToHex(Buffer.from(nextInput.hash).reverse())

            if (removeSpent) {
                const prevTxHash8 = prevTxHashHex.substring(0, 16)
                await db.removeOutputWithInput({prevTxHash: prevTxHash8, prevOutputIndex: nextInput.index, blockHash: blockHash})
            } else {
                await db.insertInput({
                    prevTxHash: prevTxHashHex,
                    prevOutputIndex: nextInput.index,
                    txHash: nextTxId8
                })
            }

            if (addHints) {
                await db.insertInputHint({
                    prevTxHash: prevTxHashHex,
                    prevOutputIndex: nextInput.index,
                    txHash: nextTxId8
                })
            }

            return 1
        }))

        return inputCounts.reduce((acc, n) => acc + n, 0)
    }

    async verifyReorg(nodeTipHeight = null){
        let thereAreDifferences = true
        let blocksDeleted = []
        let retryCount = 0

        while (thereAreDifferences){
            let lastBlockIndex = await this.db.getLastBlockHeight()
            let lastBlockHash = await this.db.getLastBlockHash()
            let lastBlock = await this.db.getBlock(lastBlockHash)
            
            console.log("Last block index is "+lastBlockIndex)
            console.log("Last block hash is "+lastBlockHash)
            console.log("Last block height is "+(lastBlock?lastBlock["h"]:"null"))
            
            if (!lastBlock || (lastBlockIndex != lastBlock["h"])){
                //This shouldn't happen, but let's try to find the real lastBlockIndex
                console.log("The blocks height for the same hash are not equal. Trying to fix the lastBlockIndex stored in db. This could take some minutes...")
                let lastBlockDb = await this.db.getLastBlock()
                console.log("Last block from db is "+(lastBlockDb?lastBlockDb:"null"))

                // getLastBlock() scans the B-prefix and returns null when it is
                // empty. If a last-block pointer is set but there are no block
                // records, the DB is corrupt and cannot self-repair; guard before
                // dereferencing lastBlockDb.height/.hash (a bare TypeError here
                // otherwise crash-loops the recovery path with no actionable signal).
                if (!lastBlockDb){
                    throw new Error("verifyReorg: cannot repair the last-block pointer: the block index (B-prefix) " +
                        "is empty while a last-block pointer is set. The DB is corrupt and cannot self-recover. " +
                        "Recovery: full resync from a known-good snapshot.")
                }

                if (lastBlock && (lastBlockDb.height != lastBlock["h"])){
                    throw Error("There are inconsistents in a block height. It should be "+lastBlockIndex+" but "+lastBlock["h"]+" was found")
                } else {
                    // Commit the pointer repair in its OWN batch so it reaches disk
                    // before the loop re-reads getLastBlockHeight/Hash (which read disk
                    // only). setLastBlockHash/Height stage into transactionArray; at
                    // boot that is the still-open constructor Map that no flush ever
                    // commits, so without an explicit endTransaction the re-read below
                    // sees the unrepaired pointer and this branch spins forever. All
                    // verifyReorg callers discard any prior batch first, so opening a
                    // fresh one here strands nothing.
                    await this.db.beginTransaction()
                    await this.db.setLastBlockHash(lastBlockDb.hash)
                    await this.db.setLastBlockHeight(lastBlockDb.height)
                    await this.db.endTransaction()
                    console.log("The new last block hash in the db is "+lastBlockDb.hash)
                    console.log("The new last block index in the db is "+lastBlockDb.height)
                    console.log("Last block index was fixed!")
                    continue
                }
            } else {
                // If the caller passed the node's current tip height and our committed
                // tip sits above it (node reset / reindex / invalidateblock regression),
                // those blocks cannot exist on the node's chain. Delete them directly
                // rather than asking the node for a hash at a height it no longer has
                // (which would error and spin this loop). Once the walk reaches the node
                // tip, the normal hash comparison below reconciles the common ancestor.
                let aboveNodeTip = (nodeTipHeight !== null && lastBlockIndex > nodeTipHeight)
                let blockHashFromNode = null
                if (!aboveNodeTip){
                    try {
                        blockHashFromNode = await this.connector.getBlockHash(lastBlockIndex)
                    } catch (err){
                        console.error('Error fetching block hash from node: ' + err.message, err)
                        await this.sleep(3000)
                        continue
                    }
                    console.log("Last block hash from node is "+blockHashFromNode)
                }

                if (aboveNodeTip || lastBlockHash != blockHashFromNode){
                    // Depth guard: spent-output recovery records (K/M entries) are
                    // retained only for the most recent UNDO_BLOCKS blocks;
                    // cleanupAgedBlocks() purges them once a block ages out of that
                    // window. Once we have already rolled back UNDO_BLOCKS blocks, the
                    // next block's recovery records are gone, so processDeletedOutputs(
                    // hash, true) would silently restore nothing and leave the UTXO
                    // index permanently under-counted for any address with outputs spent
                    // in those blocks. A loud abort is strictly safer than a silently
                    // corrupt index: stop here and require an operator-driven resync.
                    if (blocksDeleted.length >= this.undoBlocks){
                        const msg = "verifyReorg: reorg depth exceeds the recovery window "
                            + "(UNDO_BLOCKS=" + this.undoBlocks + "). Already rolled back "
                            + blocksDeleted.length + " blocks; spent-output recovery records "
                            + "for block height " + lastBlockIndex + " and below have already "
                            + "been purged, so continuing would silently leave the UTXO index "
                            + "under-counted. Aborting. Recovery: perform a full resync from a "
                            + "known-good snapshot."
                        console.error(msg)
                        throw XChainUtxoTracker.markUnrecoverableReorg(new Error(msg))
                    }
                    try {
                        await this.db.beginTransaction()
                        if (REMOVE_SPENT){
                            await this.db.removeOutputScriptsInBlock(lastBlockHash)
                            await this.db.processDeletedOutputs(lastBlockHash, true)
                            // Purge outputs created in the rolled-back block that were
                            // never spent (processDeletedOutputs only restores outputs
                            // spent in it. Runs last so any output both created and spent
                            // in this block (just re-staged above) is removed, not revived.
                            await this.db.removeCreatedOutputsInBlock(lastBlockHash)
                        }
                        await this.db.deleteBlock(lastBlockHash)
                        await this.removeFromLastBlocks(lastBlockHash)
                        await this.db.setLastBlockHash(lastBlock["ph"])
                        await this.db.setLastBlockHeight(lastBlock["h"]-1)
                        await this.db.endTransaction()

                        console.log("Removed block "+lastBlockHash+" ("+lastBlock["h"]+")")
                        console.log("Rollback to previous block "+lastBlock["ph"]+" ("+(lastBlock["h"]-1)+")")

                        // Per-block retry budget: reset after each successful rollback so the
                        // 10-attempt limit applies per block, not cumulatively across the whole
                        // reorg run. Otherwise a multi-block reorg with one transient failure per
                        // block could exhaust the budget and abort, leaving orphan blocks behind.
                        retryCount = 0
                        blocksDeleted.push({"block_index":lastBlockIndex, "block_hash":lastBlockHash})
                    } catch (err){
                        try { await this.db.endTransaction(false) } catch (_) {}
                        // An unrecoverable reorg (rolled back past the tracked window)
                        // re-throws identically on every retry (the reloaded window is
                        // still empty), so fail out immediately, tagged, rather than
                        // burn 10 pointless retries before aborting.
                        if (XChainUtxoTracker.isUnrecoverableReorg(err)) throw err
                        // The rollback batch was discarded, so the block's on-disk N
                        // record still exists, but removeFromLastBlocks already pop()ed
                        // it from the in-memory this.lastBlocks before the commit failed.
                        // Left as-is, every retry re-reads the same lastBlockHash from disk
                        // while lastBlocks no longer ends with it, so removeFromLastBlocks
                        // throws deterministically on all 10 attempts and a single transient
                        // I/O blip becomes a guaranteed process exit. Resync the in-memory
                        // window from disk (which still holds the N records) so the retry
                        // budget actually retries.
                        try { this.lastBlocks = await this.loadLastBlocksSortedByHeight() } catch (_) {}
                        console.error(`verifyReorg: failed to delete block ${lastBlock["h"]} (${lastBlockHash}): ${err.message}`, err)
                        if (++retryCount >= 10) throw new Error('verifyReorg: deleteBlockByIndex failed after 10 attempts, aborting')
                        await this.sleep(3000); continue
                    }
                } else {
                    thereAreDifferences = false
                }
            }
        }
        
        if (blocksDeleted.length > 0){
            console.log(blocksDeleted.length+" blocks were removed")
            this.reorgCount++
            this.lastReorgDepth = blocksDeleted.length
        }

        return true
    }
    
    
    async start(){
        this.db = new LevelUpStore(this.dbName)
        this.mempoolDb = new LevelUpStore("mempool"+this.dbName, true)
        await this.db.createDatabase()
        await this.mempoolDb.createDatabase()
        
        console.log("Indexing...")
        
        let lastProcessedBlockIndex = await this.db.getLastBlockHeight()
        let lastProcessedBlockHash = await this.db.getLastBlockHash()

        // Load in ascending height order (tip last) so a reorg right after a
        // restart doesn't trip removeFromLastBlocks. See helper for detail.
        this.lastBlocks = await this.loadLastBlocksSortedByHeight()

        // Recover any K/M cleanup work that was staged but not completed before a prior crash.
        // abstract-level .get returns undefined on a missing key (no throw); real
        // I/O errors still propagate.
        const pVal = await this.db.db.get(P_PENDING_CLEANUP_KEY)
        if (pVal !== undefined) {
            this.pendingKMCleanup = JSON.parse(pVal.toString())
            if (this.pendingKMCleanup.length > 0) {
                console.log(`Recovering ${this.pendingKMCleanup.length} pending K/M cleanup block(s) from prior crash`)
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

        // Track consecutive block-fetch failures at the SAME height. A node
        // pruned past our cursor (or any permanent fetch fault) otherwise retries
        // every 3s forever with no fail-loud signal. Reset on any successful fetch
        // or a height change so ordinary transient blips never accumulate toward
        // the desync threshold.
        let blockFetchFailures = 0
        let blockFetchFailureHeight = null

        while (true){
            if (this.keepParsing){
                // Refresh node tip when: no info yet, caught up to the previously-seen tip,
                // OR periodically so blockchainInfoLastBlock stays current during catch-up
                // (synced flag and confirmations reflect the true tip, not a frozen startup value).
                if (!lastBlockchainInfo
                    || (lastProcessedBlockIndex >= this.blockchainInfoLastBlock)
                    || (Date.now() - lastBlockchainInfoRefreshAt >= BLOCKCHAIN_INFO_REFRESH_MS)){
                    try {
                        lastBlockchainInfo = await this.connector.getBlockchainInfo()
                        this.latestKnownChainTip = lastBlockchainInfo["blocks"]

                        if (lastBlockchainInfo["verificationprogress"] < MIN_VERIFICATION_PROGRESS_TO_PARSE){
                            if (!nodeSyncedProblem){
                                console.log("The node is not synced. Waiting for it to synchronize...")
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
                        console.error('Error fetching blockchain info from node: ' + e.message, e)
                        await this.sleep(3000)
                        continue
                    }
                    
                    if (lastProcessedBlockIndex > this.blockchainInfoLastBlock){
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
                        console.log("The last processed block height are greater than the last block of the node. Trying to fix the lastBlockIndex stored in db. This could take some minutes...")
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
                            console.log("WARNING! The last processed block height ("+lastBlockDb.height+") is greater than the last block from the network ("+this.blockchainInfoLastBlock+"). The node likely reset or reorged below our tip; rolling back to its chain.")
                            this.lastBlocks = await this.loadLastBlocksSortedByHeight()
                            await this.verifyReorg(this.blockchainInfoLastBlock)
                            lastProcessedBlockIndex = await this.db.getLastBlockHeight()
                            lastProcessedBlockHash = await this.db.getLastBlockHash()
                            continue
                        } else {
                            await this.db.setLastBlockHash(lastBlockDb.hash)
                            await this.db.setLastBlockHeight(lastBlockDb.height)
                            lastProcessedBlockIndex = lastBlockDb.height
                            lastProcessedBlockHash = lastBlockDb.hash
                            console.log("Last block index was fixed!")
                            continue
                        }
                    }
                }
                
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
                            console.error('Error re-checking the committed tip hash from node: ' + err.message, err)
                        }
                        if (tipHashFromNode && tipHashFromNode != lastProcessedBlockHash){
                            console.log("A same-height tip reorg has been detected. Cleaning blocks...")
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
                        console.log("Mempool updates started!")
                        this.updateMempool()
                        this.mempoolInterval = setInterval(this.updateMempool.bind(this), MEMPOOL_INTERVAL)
                    }

                    await this.sleep(CHECK_BLOCK_DELAY_MS)
                } else {
                    if ((this.blockchainInfoLastBlock - lastProcessedBlockIndex) > SYNCED_THRESHOLD){
                        this.synced = false
                        // Falling out of sync invalidates mempool readiness: the
                        // mempool poller is torn down here and must reconverge once
                        // before readiness is asserted again.
                        this.mempoolReconverged = false
                        if (this.mempoolInterval != null){
                            console.log("Mempool updates stopped!")
                            clearInterval(this.mempoolInterval)
                            this.mempoolInterval = null
                        }
                    }

                    let nextBlockHeight = lastProcessedBlockIndex + 1

                    // Kick off pre-fetches for upcoming blocks while we process the current one
                    fillPrefetchQueue(nextBlockHeight, this.blockchainInfoLastBlock)

                    let nextBlockHash = null
                    let nextBlockHex = null
                    try {
                        let fetched
                        if (this.shouldReassembleBlock(nextBlockHeight, blockFetchFailureHeight, blockFetchFailures)) {
                            // Deterministic-looking failure streak at this height on an
                            // AuxPoW chain: bypass the prefetch queue (its batch
                            // strip would just fail the same way) and rebuild the pure
                            // block per-tx, never reading the AuxPoW bytes.
                            console.error('Block fetch at height ' + nextBlockHeight + ' failed ' + blockFetchFailures +
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
                        // transient blip starts counting from zero again.
                        blockFetchFailures = 0
                        blockFetchFailureHeight = null
                    } catch (e){
                        prefetchQueue = []
                        // noteBlockFetchFailure counts consecutive failures at this
                        // height and THROWS a diagnosable desync error once the bound
                        // is hit, so a node pruned past our cursor fails loud instead
                        // of spinning every 3s forever.
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

                    if (nextBlockHeight > 0){
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
                            console.log("A reorg has been detected. Cleaning blocks...")
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
                            console.log("Blocks were updated")
                            continue
                        }
                    }
                    if (blocksQuantity == 0){
                        await this.db.beginTransaction()
                    }

                    await this.db.insertBlock({hash:nextBlockHash, height:nextBlockHeight, timestamp:block.timestamp, previousHash:previousBlockHash})
                    blocksCount = blocksCount + 1               
                    
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

                    await this.addToLastBlocks(nextBlockHash)

                    // Flush triggers: batch full, at chain tip, or heap pressure.
                    const _earlyFlushHeapMB = process.memoryUsage().heapUsed / 1048576
                    const _flushReason =
                        (nextBlockHeight == this.blockchainInfoLastBlock)             ? 'tip' :
                        (blocksQuantity == DB_TRANSACTION_BLOCKS_QUANTITY-1)          ? 'batch-full' :
                        (_earlyFlushHeapMB > HEAP_FLUSH_THRESHOLD_MB)                 ? 'heap-pressure' :
                        null
                    if (_flushReason){
                        console.log("Indexing block "+(nextBlockHeight)+"("+nextBlockHash+")")
                        await this.db.setLastBlockHeight(nextBlockHeight)
                        await this.db.setLastBlockHash(nextBlockHash)
                        console.log("Inserting data Blocks ("+blocksCount+") Transactions ("+transactionsCount+") Inputs ("+inputsCount+") Outputs("+outputsCount+")")

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
                        console.log(`⏱ TIMING (${_t.blocks} blocks) flush=${_flushReason} total=${_total}ms | decode=${_t.decode}ms | parse=${_t.parse}ms (out=${_t.parseOut}ms [hash=${_pb.hash}ms ins=${_pb.ins}ms sb=${_pb.sb}ms] in=${_t.parseIn}ms [hintRead=${_pi.hintRead}ms outRead=${_pi.outRead}ms stage=${_pi.stage}ms]) | commit=${_t.commit}ms | cleanup=${_t.cleanup}ms | knownScripts=${_ks.size} hit=${_ksH} miss=${_ksM} rate=${_ksRate}% | heap=${_heapMB}MB heapPre=${_earlyFlushHeapMB.toFixed(0)}MB rss=${_rssMB}MB outCache=${_ocSize}`)
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
                            console.log(`⚡ Speed: ${(1000/msPerTx).toFixed(1)} tx/s | avg ${avgTxPerBlock.toFixed(0)} tx/block (last ${newest.height - oldest.height} blocks)`)
                            console.log("Estimated time to finish: "+this.millisecondsToTimeString(msLeft))
                        }
                        
                        blocksQuantity = -1
                    }
                    
                    blocksQuantity = blocksQuantity + 1
                    lastProcessedBlockIndex = nextBlockHeight
                    lastProcessedBlockHash = nextBlockHash
                }
            } else {
                console.log("Stopping the parsing...")
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
    
    async updateMempool(){
        if (!this.mempoolBusy){
            let mempoolStartTime = Date.now()
            this.mempoolBusy = true
            let rawMempool = []
            try {
                let rawMempoolUnordered = await this.connector.getRawMempool()
                
                for (let nextUnorderedItemIndex in rawMempoolUnordered){
                    let nextUnorderedItem = rawMempoolUnordered[nextUnorderedItemIndex]

                    // binary-search convention: comparator(element, needle)
                    // returns negative when element < needle (search right).
                    // Pairs with deleteAndCompareTxsNotInList downstream, which
                    // uses the same convention after the fix in commit 095bee7;
                    // both must use the SAME polarity for the sorted list to
                    // round-trip correctly.
                    let newIndex = bs(rawMempool, nextUnorderedItem, function(element, needle) { return element.localeCompare(needle) })

                    if (newIndex < 0){
                        rawMempool.splice(-newIndex-1, 0, nextUnorderedItem)
                    }
                }
                
                
                
            } catch (error){
                console.error('Error updating mempool: ' + error.message, error)
                // Reset the busy flag: without this, a single transient
                // getRawMempool failure permanently locks out further mempool
                // updates for the lifetime of the process (next setInterval
                // tick sees mempoolBusy=true and bails).
                this.mempoolBusy = false
                return
            }
            
            let transactionsCount = 0
            let inputsCount = 0
            let outputsCount = 0
            
            
            let deletedTransactionsCount = 0
            let deletedInputsCount = 0
            let deletedOutputsCount = 0

            try {
                // Phase 1: prune txs no longer in the node mempool and dedup
                // rawMempool down to only-new txids. This is a DB-only step
                // (no RPC, no sleep), so its write transaction opens and commits
                // immediately. The old single begin/endTransaction
                // spanned the ENTIRE multi-batch fetch/sleep loop below, so on a
                // large mempool (50k txs -> tens of batches, ~1.5s sleep each)
                // the mempool write path stayed uncommitted for >75s. Pending
                // balances read from disk saw the previous pass's stale snapshot
                // for that whole window, and the batch commit landed all-or-
                // nothing at the very end. Scoping the transaction per-batch lets
                // each committed batch become queryable as soon as it lands.
                await this.mempoolDb.beginTransaction()
                try {
                    //This deletes the txs that are in the database but not longer in the mempool. Also, it removes
                    //the transactions that already exist in the database, leaving rawMempool only with the new transactions from the mempool
                    let deletedInfo = await this.mempoolDb.deleteAndCompareTxsNotInList(rawMempool)
                    await this.mempoolDb.endTransaction()
                    deletedTransactionsCount = deletedInfo.transactionsDeleted
                    deletedInputsCount = deletedInfo.inputsDeleted
                    deletedOutputsCount = deletedInfo.outputsDeleted
                } catch (err){
                    // Close the prune transaction before rethrowing so the batch
                    // loop below never starts on top of a half-open transaction.
                    try { await this.mempoolDb.endTransaction(false) } catch (_) {}
                    throw err
                }

                // Multi-batch passes are throttled by an inter-batch sleep; on a
                // large mempool the cumulative sleep dominates the wall-clock cost
                // of reconverging the in-memory mempool snapshot. Surface an estimate
                // up front so operators can correlate stale pending-balance windows
                // with mempool depth during fee spikes.
                if (rawMempool.length > MEMPOOL_BATCH_SIZE){
                    let batchCount = Math.ceil(rawMempool.length / MEMPOOL_BATCH_SIZE)
                    let estimatedSeconds = ((batchCount - 1) * MEMPOOL_INTER_BATCH_SLEEP) / 1000
                    console.log("Mempool update: "+batchCount+" batches required, estimated minimum reconvergence "+estimatedSeconds+"s")
                }

                // Phase 2: fetch each batch's raw txs (RPC) and the inter-batch
                // sleep OUTSIDE any open write transaction; only the parse/stage of
                // the already-fetched batch runs inside its own short-lived
                // begin/endTransaction. The write path is released between batches,
                // so mid-pass pending-balance reads and block-confirmation cleanup
                // see each batch as soon as it commits instead of waiting for the
                // whole reconvergence.
                let i = 0
                let consecutiveTxFetchFailures = 0
                while(i<rawMempool.length){
                    let nextRawMempoolChunk = rawMempool.slice(i, i+MEMPOOL_BATCH_SIZE)

                    let nextTxsHex = []
                    try {
                        nextTxsHex = await this.connector.getRawTransactions(nextRawMempoolChunk)
                        // Successful fetch: clear the per-pass streak so a future
                        // transient blip starts counting from zero again.
                        consecutiveTxFetchFailures = 0

                    } catch (err){
                        console.log(err)
                        consecutiveTxFetchFailures = consecutiveTxFetchFailures + 1
                        // Increment the lifetime counter so get_sync_status can surface
                        // that this node is degraded on mempool fetches.
                        this.mempoolRpcFailures++
                        this.lastMempoolErrorAt = Date.now()
                        // If the node stays down, retrying forever here would keep
                        // execution inside the outer try and never reach the finally
                        // that resets mempoolBusy, locking out all future mempool
                        // updates and block sync until a process restart. Bail out
                        // after a bounded number of consecutive failures so the
                        // finally fires and the next interval tick can recover.
                        // The fetch runs before beginTransaction, so bailing here
                        // never strands an open transaction.
                        // Throw rather than break: Phase 1's prune already COMMITTED, so
                        // abandoning the fetch here leaves a snapshot that is missing the
                        // new mempool spends, and a plain break fell through to the
                        // unconditional readiness assignment below and published it as
                        // reconverged. getUtxosAddress then served the confirmed inputs of
                        // spends it could not see. The outer catch de-asserts
                        // readiness for this and every other mid-pass fault, and finally
                        // still clears mempoolBusy so the next tick recovers.
                        if (consecutiveTxFetchFailures >= MEMPOOL_MAX_TX_FETCH_RETRIES){
                            console.warn("Giving up on this mempool pass after "+consecutiveTxFetchFailures+" consecutive getRawTransactions failures; will retry on the next interval.", err)
                            throw new Error("mempool fetch incomplete after "+consecutiveTxFetchFailures+" consecutive getRawTransactions failures")
                        }
                        console.log("There was an error trying to get raw transactions from the mempool. Trying again...", err)
                        await this.sleep(1000)
                        continue
                    }

                    // Parse + stage this fetched batch inside its own transaction,
                    // committed before the inter-batch sleep so readers see it.
                    await this.mempoolDb.beginTransaction()
                    try {
                        for (let nextTxHexIndex in nextTxsHex){
                            let nextTxHex = nextTxsHex[nextTxHexIndex]

                            if (nextTxHex != null){
                                let nextTx = this.xchainBlockDecoder.txFromHex(nextTxHex)

                                let countInfo = await this.parseTransaction(this.mempoolDb, nextTx, null, -1, true)

                                if (transactionsCount % MEMPOOL_BATCH_SIZE == 0){
                                    console.log(""+transactionsCount+" parsed txs of "+rawMempool.length)
                                }

                                transactionsCount = transactionsCount + 1
                                inputsCount = inputsCount + countInfo["inputsCount"]
                                outputsCount = outputsCount + countInfo["outputsCount"]
                            }
                        }
                        await this.mempoolDb.endTransaction()
                    } catch (err){
                        // Discard this batch's staged writes and rethrow to the
                        // outer handler; mempoolBusy is cleared in finally.
                        try { await this.mempoolDb.endTransaction(false) } catch (_) {}
                        throw err
                    }

                    i = i + MEMPOOL_BATCH_SIZE
                    // Only throttle between batches: the inter-batch sleep is for
                    // CPU/IO breathing room when a giant mempool needs many passes.
                    // If we just finished the final batch (or only batch), don't
                    // skip the sleep: single-batch updates (typical for regtest and most
                    // mainnet conditions) shouldn't pay a tail latency.
                    if (i < rawMempool.length) {
                        await this.sleep(MEMPOOL_INTER_BATCH_SLEEP)
                    }
                }

                // Every batch that was fetched has been committed, so the in-memory
                // mempool DB now reflects the node mempool: readiness can be
                // asserted. Reset to false on any synced=false transition (see
                // above) and on mempool errors, which take the catch path below.
                this.mempoolReconverged = true
                let mempoolEndTime = Date.now()
                let timeString = this.millisecondsToTimeString(mempoolEndTime-mempoolStartTime)

                console.log("Mempool updated!"
                    +" Transactions ("+transactionsCount+" more, "+deletedTransactionsCount+" less)"
                    +" Inputs ("+inputsCount+" more, "+deletedInputsCount+" less) "
                    +" Outputs("+outputsCount+" more, "+deletedOutputsCount+" less) ["+timeString+"]")
            } catch (error){
                // Any failure in the prune/parse/commit path (txFromHex on
                // malformed hex, a parseTransaction error, or a DB I/O fault) must
                // not leave mempoolBusy stuck true; otherwise every subsequent
                // setInterval tick bails with "Mempool is still busy" and the
                // mempool silently stagnates for the lifetime of the process. Each
                // phase above already closes its own transaction on error, so there
                // is nothing left open to roll back here.
                console.error('Error during mempool update: ' + error.message, error)
                // Every route into this catch leaves a post-prune snapshot that is
                // missing some advertised mempool txs, so readiness must be withdrawn
                // rather than left asserted from an earlier good pass. The
                // next successful pass re-asserts it at the end of the try block.
                this.mempoolReconverged = false
            } finally {
                this.mempoolBusy = false
            }
        } else {
            console.log("Mempool is still busy")
        }
    }
    
}

module.exports = XChainUtxoTracker
module.exports.satoshiToDecimalString = satoshiToDecimalString
module.exports.SYNCED_THRESHOLD = SYNCED_THRESHOLD
module.exports.MAX_ADDRESS_OUTPUTS = MAX_ADDRESS_OUTPUTS
module.exports.MAX_BLOCK_FETCH_RETRIES = MAX_BLOCK_FETCH_RETRIES
// Exported for the malformed-AuxPoW fallback regression test.
module.exports.AUXPOW_REASSEMBLE_AFTER = AUXPOW_REASSEMBLE_AFTER
module.exports.COINBASE_MATURITY = COINBASE_MATURITY