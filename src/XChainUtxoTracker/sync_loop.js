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

const LevelUpStore = require('../store/level_up_db.js')
const { BLOCKCHAIN_INFO_REFRESH_MS, P_PENDING_CLEANUP_KEY, logger } = require('./constants.js')
const { refreshNodeTip, pollAtTipOrIndex } = require('./sync_loop_node_tip.js')

module.exports = {
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

        const cursor = await loadSyncCursor.call(this)
        recoverPendingCleanup.call(this, cursor.pendingCleanup)
        const sync = newSyncLoopState.call(this, cursor)

        this.keepParsing = true
        this.parsingStopped = false
        // A relaunched loop is running again, so the previous abort no longer
        // describes it; leaving this set would let stopParsing close a live store.
        this.parsingAborted = false

        while (true){
            if (this.keepParsing){
                // A pass whose last node or store call leaves bookkeeping behind
                // hands it back as `finish`, which runs here before the loop goes
                // round, so no await separates the two.
                const finish = await pollSyncLoop.call(this, sync)
                if (finish) finish()
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

// The sync loop's steps. Each runs with the tracker as `this` (called through
// .call) and shares the loop's working state through `sync`, so they stay off
// the class prototype. The loop yields only where it awaits a node call, a
// store call or a sleep: an async step returns only right after such an await,
// a step whose work runs on synchronously hands the pass to the next step by
// returning that step's call, and the synchronous stretches are plain functions.

// Loads the committed cursor and the in-memory windows the loop starts from:
// the tip height and hash, the last-blocks window and the undo watermark, and
// reads any K/M cleanup list a crash left staged.
async function loadSyncCursor(){
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
    const pendingCleanup = await this.db.db.get(P_PENDING_CLEANUP_KEY)
    return { lastProcessedBlockIndex, lastProcessedBlockHash, pendingCleanup }
}

// Takes up the staged K/M cleanup list read from the P key, when there is one.
function recoverPendingCleanup(pVal){
    if (pVal !== undefined) {
        this.pendingKMCleanup = JSON.parse(pVal.toString())
        if (this.pendingKMCleanup.length > 0) {
            logger.info(`Recovering ${this.pendingKMCleanup.length} pending K/M cleanup block(s) from prior crash`)
        }
    }
}

// The loop's working state: the in-memory cursor, the open batch's counters and
// timings, the prefetch queue, and the latches and streaks that keep a fault to
// one log line per transition. Also seeds the node-RPC stamps /status reads.
function newSyncLoopState({ lastProcessedBlockIndex, lastProcessedBlockHash }){
    const sync = { lastProcessedBlockIndex, lastProcessedBlockHash, lastBlockchainInfo: null, lastBlockchainInfoRefreshAt: 0 }
    // Instance-visible twin of lastBlockchainInfoRefreshAt, read by GET /status.
    // The sync loop retries a failing getBlockchainInfo forever, so a coin node
    // that is down or unsynced stalls block tracking while LevelDB stays perfectly
    // readable and the DB-only probe kept reporting 'ok'. Seeded here
    // rather than in the constructor so the window starts when tracking starts.
    this.lastNodeRpcOkAt = Date.now()
    this.blockchainInfoLastBlock = -1
    return Object.assign(sync, {
        blocksQuantity: 0,
        // Transactions confirmed in this batch that need their mempool records
        // removed. Collected per-block and flushed AFTER db.endTransaction() so
        // confirmed outputs are always committed before mempool records are deleted,
        // closing the brief "in neither store" window described in the ordering fix.
        pendingMempoolTxCleanup: [],
        blockTimestamps: [], // Rolling window of {height, time, txCount} for ETA calculation
        _t: { fetch: 0, decode: 0, parse: 0, parseOut: 0, parseIn: 0, commit: 0, cleanup: 0, blocks: 0 },
        blocksCount: 0,
        transactionsCount: 0,
        inputsCount: 0,
        outputsCount: 0,
        // Prefetch queue: each entry is { height, promise } where promise resolves to { hash, hex }
        prefetchQueue: [],
        nodeSyncedProblem: false,
        // Node-tip-below-ours latches, one line per transition each: the node is
        // still in initial block download (wait, never reconcile), or the gap is
        // too deep to walk back and verifyReorg refused before deleting (wait,
        // keep serving, say so once).
        nodeCatchingUpProblem: false,
        tipBelowCommittedTipRefused: false,
        // Track consecutive block-fetch failures at the SAME height. A node
        // pruned past our cursor (or any permanent fetch fault) otherwise retries
        // every 3s forever with no fail-loud signal. Reset on any successful fetch
        // or a height change so ordinary transient blips never accumulate toward
        // the desync threshold.
        blockFetchFailures: 0,
        blockFetchFailureHeight: null,
        // A SECOND streak, counting only AuxPoW-strip (content) faults. The one
        // above answers "can this node serve this block at all" and drives the
        // fail-loud desync halt; this one answers "are this block's bytes the
        // problem" and is the only thing allowed to trigger per-tx reassembly.
        // Merging them aimed the reassembly RPC fan-out at whatever node had just
        // gone unreachable for five polls.
        auxPowParseFailures: 0,
        auxPowParseFailureHeight: null,
    })
}

// One pass of the sync loop while parsing is on: refresh the node's tip when it
// is due, then either wait at the tip or index the next block. Resolves to the
// pass's leftover bookkeeping, if any, for start() to run.
function pollSyncLoop(sync){
    // Refresh node tip when: no info yet, caught up to the previously-seen tip,
    // OR periodically so blockchainInfoLastBlock stays current during catch-up
    // (synced flag and confirmations reflect the true tip, not a frozen startup value).
    //Getting the last block from the blockchain.
    //Refresh when we have no info yet, when we have caught up to the
    //previously-seen tip, OR periodically on a wall-clock interval: the
    //last condition keeps blockchainInfoLastBlock tracking the live chain
    //during a long catch-up, so the synced flag and reported confirmations
    //reflect the true chain tip instead of a frozen startup value.
    if (!sync.lastBlockchainInfo
        || (sync.lastProcessedBlockIndex >= this.blockchainInfoLastBlock)
        || (Date.now() - sync.lastBlockchainInfoRefreshAt >= BLOCKCHAIN_INFO_REFRESH_MS)){
        return refreshNodeTip.call(this, sync)
    }
    return pollAtTipOrIndex.call(this, sync)
}
