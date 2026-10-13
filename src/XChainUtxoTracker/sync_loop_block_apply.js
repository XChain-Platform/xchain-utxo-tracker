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

const util = require('../common/util')
const { DB_TRANSACTION_BLOCKS_QUANTITY, HEAP_FLUSH_THRESHOLD_MB, P_PENDING_CLEANUP_KEY, REMOVE_SPENT, SYNCED_THRESHOLD, logger } = require('./constants.js')
const { fillPrefetchQueue, fetchNextBlock } = require('./sync_loop_block_fetch.js')
const { withStoreCommit } = require('./address_queries.js')
const { logBatchTiming, recordSyncProgress, logSyncEta } = require('./sync_loop_progress.js')

// Sync loop steps, called with the tracker as `this`; sync_loop.js says how.

// Behind the node's tip: fetch, check and stage the next block, flush the batch
// when a trigger fires, then advance the in-memory cursor.
async function indexNextBlock(sync){
    //Put the flag synced false if there are too many blocks behind
    if ((this.blockchainInfoLastBlock - sync.lastProcessedBlockIndex) > SYNCED_THRESHOLD){
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
    let nextBlockHeight = sync.lastProcessedBlockIndex + 1

    // Kick off pre-fetches for upcoming blocks while we process the current one
    fillPrefetchQueue.call(this, sync, nextBlockHeight, this.blockchainInfoLastBlock)

    const fetched = await fetchNextBlock.call(this, sync, nextBlockHeight)
    if (!fetched) return
    const nextBlockHash = fetched.hash

    const _tDecode = Date.now()
    var block = this.xchainBlockDecoder.blockFromHex(fetched.hex)
    let previousBlockHash = util.uint8ArrayToHex(Buffer.from(block.prevHash).reverse())
    sync._t.decode += Date.now() - _tDecode

    //Check if there is a reorg
    if (nextBlockHeight > 0){
        //previousBlockHash is not the same, it must be a reorg
        if (previousBlockHash != sync.lastProcessedBlockHash){
            return rollBackOnPrevHashMismatch.call(this, sync)
        }
    }
    await stageBlock.call(this, sync, block, nextBlockHash, nextBlockHeight, previousBlockHash)
    const flush = flushTrigger.call(this, sync, nextBlockHeight)
    if (flush) return flushBatch.call(this, sync, flush, nextBlockHash, nextBlockHeight)
    advanceCursor(sync, nextBlockHash, nextBlockHeight)
}

// The next block's parent is not our tip, so the node reorganized under us:
// discard the open batch and roll back to the common ancestor. Hands back the
// batch reset.
async function rollBackOnPrevHashMismatch(sync){
    sync.prefetchQueue = []
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
    await verifyReorgHandingBackTipRefusal.call(this, sync)
    sync.lastProcessedBlockIndex = await this.db.getLastBlockHeight()
    sync.lastProcessedBlockHash = await this.db.getLastBlockHash()

    // The P key was persisted above (standalone put, outside the
    // rolled-back batch) so a restart would re-run cleanupAgedBlocks.
    // Run it now so aged-out K/M/W records are purged immediately
    // and the P key is deleted atomically, not left on disk until
    // the next restart or flush.
    await this.cleanupAgedBlocks()

    return () => {
        resetBatchAfterReorg.call(this, sync)
        logger.info("Blocks were updated")
    }
}

// Stages one block into the batch, opening the batch on its first block: the
// block record, its outputs and spent inputs, the counters, the txids whose
// mempool records go at the next flush, and the last-blocks window entry.
async function stageBlock(sync, block, nextBlockHash, nextBlockHeight, previousBlockHash){
    //Start a transaction if there are no blocks processed yet
    if (sync.blocksQuantity == 0){
        await this.db.beginTransaction()
    }

    //Insert the processed block
    await this.db.insertBlock({hash:nextBlockHash, height:nextBlockHeight, timestamp:block.timestamp, previousHash:previousBlockHash})
    sync.blocksCount = sync.blocksCount + 1

    //Parse the transactions (two-pass approach to allow full parallelism):
    //  Pass 1: insert all outputs for every tx concurrently
    //  Pass 2: process all inputs concurrently (same-block outputs are
    //          now in transactionArray so removeOutputWithInput finds them)
    var transactions = block.transactions
    const { blockOutputCounts, blockInputTotal } = await parseBlockTransactions.call(this, sync, transactions, nextBlockHash, nextBlockHeight)

    sync.transactionsCount = sync.transactionsCount + transactions.length
    sync.outputsCount = sync.outputsCount + blockOutputCounts.reduce((acc, n) => acc + n, 0)
    sync.inputsCount  = sync.inputsCount  + blockInputTotal

    // Collect txids for mempool cleanup. The actual deletions are
    // deferred to after db.endTransaction() at flush time so that
    // confirmed outputs are always committed before their mempool
    // records are removed, closing the window where a just-mined
    // UTXO would transiently appear in neither the confirmed nor
    // the mempool store. The cleanup is a no-op for txs the
    // mempool poll never saw (most in regtest).
    for (const tx of transactions) {
        sync.pendingMempoolTxCleanup.push(tx.getId())
    }

    //Add the block to the last blocks
    await this.addToLastBlocks(nextBlockHash)
}

// The block's two parse passes, timed into the batch's buckets: every tx's
// outputs in tx-index order, then every spent input removed in one batch.
async function parseBlockTransactions(sync, transactions, nextBlockHash, nextBlockHeight){
    const _tParse = Date.now()
    const _tParseOut = Date.now()
    // Sequential in tx-index order so that S-record writes across
    // txs in the same block land in deterministic (tx-index, vout)
    // order, matching bulk-sync.
    const blockOutputCounts = new Array(transactions.length)
    for (let txIdx = 0; txIdx < transactions.length; txIdx++) {
        const tx = transactions[txIdx]
        // parseTxOutputs only writes the T (txid->block) record when
        // removeSpent is false, and REMOVE_SPENT is true on this path, so the
        // exact-txid index is written here directly rather than by threading
        // another flag through parseTxOutputs.
        const txId = tx.getId()
        await this.db.insertTransaction({ hash: txId, blockHash: nextBlockHash })
        blockOutputCounts[txIdx] = await this.parseTxOutputs(
            this.db, tx, nextBlockHash, nextBlockHeight, false, REMOVE_SPENT
        )
    }
    sync._t.parseOut += Date.now() - _tParseOut
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
    sync._t.parseIn += Date.now() - _tParseIn
    sync._t.parse += Date.now() - _tParse
    return { blockOutputCounts, blockInputTotal }
}

// Why the batch flushes after this block, or null: the node's tip reached, the
// batch full, or the heap under pressure (sampled here for the timing line).
function flushTrigger(sync, nextBlockHeight){
    // Flush triggers: batch full, at chain tip, or heap pressure.
    //If there are enough processed blocks, then add them to the database.
    //Three triggers: batch full, at chain tip, or heap under pressure.
    //Heap-pressure flush keeps the block-count constant working as an
    //upper bound while preventing V8 OOM on dense chain windows where a
    //full 200-block batch would push staged Buffers past the heap cap.
    const _earlyFlushHeapMB = process.memoryUsage().heapUsed / 1048576
    const _flushReason =
        (nextBlockHeight == this.blockchainInfoLastBlock)             ? 'tip' :
        (sync.blocksQuantity == DB_TRANSACTION_BLOCKS_QUANTITY-1)     ? 'batch-full' :
        (_earlyFlushHeapMB > HEAP_FLUSH_THRESHOLD_MB)                 ? 'heap-pressure' :
        null
    return _flushReason ? { reason: _flushReason, heapMB: _earlyFlushHeapMB } : null
}

// Commits the batch with the tip pointer and the aged-block list, stamps the
// forward-progress heartbeat, then runs the deferred mempool and K/M cleanups.
// Hands back the flush's bookkeeping.
async function flushBatch(sync, flush, nextBlockHash, nextBlockHeight){
    logger.info("Indexing block "+(nextBlockHeight)+"("+nextBlockHash+")")
    await this.db.setLastBlockHeight(nextBlockHeight)
    await this.db.setLastBlockHash(nextBlockHash)
    logger.info("Inserting data Blocks ("+sync.blocksCount+") Transactions ("+sync.transactionsCount+") Inputs ("+sync.inputsCount+") Outputs("+sync.outputsCount+")")

    // Atomically record which blocks need K/M cleanup so a crash between
    // endTransaction and cleanupAgedBlocks is recoverable on restart.
    if (this.pendingKMCleanup.length > 0) {
        await this.db.addTransaction("put", P_PENDING_CLEANUP_KEY,
            Buffer.from(JSON.stringify(this.pendingKMCleanup)))
    }

    await commitWithMempoolCleanup.call(this, sync, nextBlockHeight)

    // Clean up K/M entries for aged-out blocks now that the batch is committed
    const _tCleanup = Date.now()
    await this.cleanupAgedBlocks()
    sync._t.cleanup += Date.now() - _tCleanup
    return () => finishFlushedBlock.call(this, sync, flush, nextBlockHash, nextBlockHeight)
}

// Commits the open batch, then drops the mined txs' mempool records, as ONE
// exclusive section of the store-commit lock (address_queries.js). Committing
// first means no single snapshot sees a mined output in neither store, but an
// address read takes two snapshots (confirmed, then mempool); without the lock
// a read whose confirmed snapshot predates the commit and whose mempool reads
// follow the cleanup misses the mined output and serves the outpoint it spent
// as unspent. The mempool mutex is taken first, outside the section, so
// readers are never held while an in-flight updateMempool() finishes.
async function commitWithMempoolCleanup(sync, nextBlockHeight){
    const cleanupTxids = sync.pendingMempoolTxCleanup
    const holdMempool = cleanupTxids.length > 0
    if (holdMempool) {
        while (this.mempoolBusy) {
            await this.sleep(50)
        }
        this.mempoolBusy = true
    }
    try {
        await withStoreCommit(this, async () => {
            const _tCommit = Date.now()
            await this.db.endTransaction()
            sync._t.commit += Date.now() - _tCommit

            // Stamp the forward-progress heartbeat only after the batch is
            // durable, so a crash mid-flush cannot leave /metrics claiming a
            // commit the DB never took.
            this.lastCommitAt = Date.now()
            this.lastCommittedHeight = nextBlockHeight

            // deleteOutputsByHint/deleteInputsByHint are per-entry read
            // streams that yield to the event loop, so the deletions go in
            // one mempool transaction for atomicity.
            if (!holdMempool) return
            await this.mempoolDb.beginTransaction()
            for (const txid of cleanupTxids) {
                await this.mempoolDb.deleteOutputsByHint(txid)
                await this.mempoolDb.deleteInputsByHint(txid)
                await this.mempoolDb.deleteTransaction(txid)
            }
            await this.mempoolDb.endTransaction()
        })
    } finally {
        if (holdMempool) this.mempoolBusy = false
    }
    if (holdMempool) sync.pendingMempoolTxCleanup = []
}

// The flush's bookkeeping once the batch and its cleanups are done: the timing
// and progress lines and a fresh batch, then the cursor moves onto the block.
function finishFlushedBlock(sync, flush, nextBlockHash, nextBlockHeight){
    logBatchTiming.call(this, sync, flush.reason, flush.heapMB)
    recordSyncProgress(sync, nextBlockHeight)
    logSyncEta.call(this, sync, nextBlockHeight)
    sync.blocksQuantity = -1
    advanceCursor(sync, nextBlockHash, nextBlockHeight)
}

// Counts the staged block into the batch and moves the in-memory cursor onto it.
function advanceCursor(sync, nextBlockHash, nextBlockHeight){
    sync.blocksQuantity = sync.blocksQuantity + 1
    sync.lastProcessedBlockIndex = nextBlockHeight
    sync.lastProcessedBlockHash = nextBlockHash
}

// After a reorg rolled the open batch back: zero the batch counters and drop the
// aged-block list, the pending mempool deletions and the ETA window.
function resetBatchAfterReorg(sync){
    sync.blocksQuantity = 0
    sync.blocksCount = 0
    sync.transactionsCount = 0
    sync.inputsCount = 0
    sync.outputsCount = 0
    this.pendingKMCleanup = []
    sync.pendingMempoolTxCleanup = []
    sync.blockTimestamps = []
    resyncMempoolAfterReorg.call(this)
}

// A reorg returns the orphaned blocks' spends to the node mempool, but the
// mempool DB only learns that on the next fixed interval tick. Until then
// get_utxos offers a prevout the node already spends, under mempool_ready true.
// Drop readiness and run a pass now. Before the poller has started, its
// first-start pass covers it; a pass already in flight predates the reorg, so
// wait it out and run a fresh one.
function resyncMempoolAfterReorg(){
    if (this.mempoolInterval == null || typeof this.updateMempool !== "function") return
    this.mempoolReconverged = false
    const pass = async () => {
        for (let i = 0; this.mempoolBusy && i < 600; i++) await new Promise(r => setTimeout(r, 100))
        this.mempoolReconverged = false
        await this.updateMempool()
    }
    pass().catch(err => logger.error("Post-reorg mempool resync failed: " + err.message))
}

// Runs a reorg walk begun without a node tip. The walk re-reads the tip when a
// hash fetch fails, so it can now refuse a gap deeper than the undo window
// (tagged tipBelowCommittedTip) before any further delete. That refusal is not
// a crash: drop the cached tip so the next pass re-reads it and routes the gap
// through rollBackToNodeTip, which waits on it, logs it once and latches it.
async function verifyReorgHandingBackTipRefusal(sync){
    try {
        await this.verifyReorg()
    } catch (err){
        if (!(err && err.tipBelowCommittedTip)) throw err
        logger.warn("Reorg walk stopped: the node's tip fell below the committed tip mid-walk, deeper than "
            + "the undo window allows; handing it back to the node tip check.")
        sync.lastBlockchainInfo = null
    }
}

// flushBatch is exported for the store-commit lock regression test.
module.exports = { indexNextBlock, resetBatchAfterReorg, resyncMempoolAfterReorg, verifyReorgHandingBackTipRefusal, flushBatch }
