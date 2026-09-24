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
const LevelUpStore = require('../store/level_up_db.js')
const { DB_TRANSACTION_BLOCKS_QUANTITY, ETA_WINDOW_BLOCKS, HEAP_FLUSH_THRESHOLD_MB, P_PENDING_CLEANUP_KEY, REMOVE_SPENT, SYNCED_THRESHOLD, logger } = require('./constants.js')
const { fillPrefetchQueue, fetchNextBlock } = require('./sync_loop_block_fetch.js')
const XChainUtxoTracker = require('../XChainUtxoTracker.js')

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
    await this.verifyReorg()
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
        sync.pendingMempoolTxCleanup.push("id" in tx ? tx["id"] : tx.getId())
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
        const txId = "id" in tx ? tx["id"] : tx.getId()
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

    const _tCommit = Date.now()
    await this.db.endTransaction()
    sync._t.commit += Date.now() - _tCommit

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
    if (sync.pendingMempoolTxCleanup.length > 0) {
        while (this.mempoolBusy) {
            await this.sleep(50)
        }
        this.mempoolBusy = true
        try {
            await this.mempoolDb.beginTransaction()
            for (const txid of sync.pendingMempoolTxCleanup) {
                await this.mempoolDb.deleteOutputsByHint(txid)
                await this.mempoolDb.deleteInputsByHint(txid)
                await this.mempoolDb.deleteTransaction(txid)
            }
            await this.mempoolDb.endTransaction()
        } finally {
            this.mempoolBusy = false
        }
        sync.pendingMempoolTxCleanup = []
    }

    // Clean up K/M entries for aged-out blocks now that the batch is committed
    const _tCleanup = Date.now()
    await this.cleanupAgedBlocks()
    sync._t.cleanup += Date.now() - _tCleanup
    return () => finishFlushedBlock.call(this, sync, flush, nextBlockHash, nextBlockHeight)
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

// The flush's timing line (per-phase milliseconds, the parse and known-script
// buckets, memory), after which every bucket starts again from zero.
function logBatchTiming(sync, _flushReason, _earlyFlushHeapMB){
    const _t = sync._t
    // ── Print timing summary ──
    _t.blocks = sync.blocksQuantity + 1
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
}

// Adds this flush to the rolling ETA window, then zeroes the batch's timings and
// counters.
function recordSyncProgress(sync, nextBlockHeight){
    // Rolling ETA based on tx throughput; window is a span of
    // ETA_WINDOW_BLOCKS blocks, not a count of samples. Each sample
    // covers DB_TRANSACTION_BLOCKS_QUANTITY blocks, so a count-based
    // trim would keep ~200× more history than intended.
    sync.blockTimestamps.push({height: nextBlockHeight, time: Date.now(), txCount: sync.transactionsCount})
    while (sync.blockTimestamps.length >= 2 &&
           (nextBlockHeight - sync.blockTimestamps[0].height) > ETA_WINDOW_BLOCKS) {
        sync.blockTimestamps.shift()
    }

    sync._t = { fetch: 0, decode: 0, parse: 0, parseOut: 0, parseIn: 0, commit: 0, cleanup: 0, blocks: 0 }
    sync.blocksCount = 0
    sync.transactionsCount = 0
    sync.inputsCount = 0
    sync.outputsCount = 0
}

// Throughput and the estimated time to the node's tip, once the ETA window
// holds two flushes.
function logSyncEta(sync, nextBlockHeight){
    const blockTimestamps = sync.blockTimestamps
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
}

module.exports = { indexNextBlock, resetBatchAfterReorg }
