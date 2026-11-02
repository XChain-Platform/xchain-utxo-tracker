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

const nodeUtil = require('node:util')
const bs = require('binary-search')
const XChainBlockDecoder = require('../chain/XChainBlockDecoder')
const { MEMPOOL_BATCH_SIZE, MEMPOOL_INTER_BATCH_SLEEP, MEMPOOL_MAX_TX_FETCH_RETRIES, logger } = require('./constants.js')
const { withStoreCommit } = require('./store_commit_lock.js')

module.exports = {
    async updateMempool(){
        if (!this.mempoolBusy){
            let mempoolStartTime = Date.now()
            this.mempoolBusy = true
            let rawMempool = []
            try {
                let rawMempoolUnordered = await this.connector.getRawMempool()
                insertSortedTxids(rawMempool, rawMempoolUnordered)
            } catch (error){
                logger.error(nodeUtil.format('Error updating mempool: ' + error.message, error))
                // Reset the busy flag: without this, a single transient
                // getRawMempool failure permanently locks out further mempool
                // updates for the lifetime of the process (next setInterval
                // tick sees mempoolBusy=true and bails).
                this.mempoolBusy = false
                return
            }

            // Read the tips after the listing, so a block mined since it shows as a mismatch.
            const mayDelete = await committedTipIsNodeTip.call(this)
            await reconvergeMempool.call(this, rawMempool, mempoolStartTime, mayDelete)
        } else {
            logger.info("Mempool is still busy")
        }
    }
}

// Inserts each txid of the node's unordered listing into rawMempool at its
// sorted position, skipping any already there.
function insertSortedTxids(rawMempool, rawMempoolUnordered){
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
}

// Allow the prune to delete only when the node's tip is the block this tracker
// committed: a tx missing from the listing may sit in a block not yet committed
// here, and deleting it early serves its spent outpoint as unspent. A failed read keeps every tx.
async function committedTipIsNodeTip(){
    try {
        const info = await this.connector.getBlockchainInfo()
        const height = await this.db.getLastBlockHeight()
        const hash = await this.db.getLastBlockHash()
        return Boolean(info) && Number(info.blocks) === height
            && typeof hash === 'string' && info.bestblockhash === hash
    } catch (err){
        logger.warn(nodeUtil.format('Mempool prune keeps every tx this pass: tip read failed: ' + (err && err.message)))
        return false
    }
}

// Phase 1 prunes the store to the node mempool, then phase 2 fetches and
// stages what is new one committed batch at a time. Readiness is asserted
// once every batch has landed and withdrawn on any fault; the pass always
// releases the busy flag.
async function reconvergeMempool(rawMempool, mempoolStartTime, mayDelete){
    const counts = { transactionsCount: 0, inputsCount: 0, outputsCount: 0,
        deletedTransactionsCount: 0, deletedInputsCount: 0, deletedOutputsCount: 0 }

    try {
        await pruneMempoolStore.call(this, rawMempool, counts, mayDelete)
        logBatchEstimate(rawMempool)

        // Phase 2: fetch each batch's raw txs (RPC) and the inter-batch
        // sleep OUTSIDE any open write transaction; only the parse/stage of
        // the already-fetched batch runs inside its own short-lived
        // begin/endTransaction. Mid-pass pending-balance reads see each batch
        // as soon as it commits. Block flushes do not: mempoolBusy is held for
        // the WHOLE pass (cleared only in the finally below), so a flush and the
        // post-reorg resync wait for every batch and inter-batch sleep, and the
        // store-commit lock around each batch commit does not shorten that wait.
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
                consecutiveTxFetchFailures = consecutiveTxFetchFailures + 1
                noteTxFetchFailure.call(this, err, consecutiveTxFetchFailures)
                await this.sleep(1000)
                continue
            }

            // Parse + stage this fetched batch inside its own transaction,
            // committed before the inter-batch sleep so readers see it.
            await stageMempoolBatch.call(this, nextTxsHex, nextRawMempoolChunk, rawMempool, counts)

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

        markMempoolReconverged.call(this, counts, mempoolStartTime)
    } catch (error){
        withdrawMempoolReadiness.call(this, error)
    } finally {
        this.mempoolBusy = false
    }
}

async function pruneMempoolStore(rawMempool, counts, mayDelete){
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
        // Off tip, dedup only: the block flush's cleanup removes mined txs, the next pass at tip evicted ones.
        let deletedInfo = await this.mempoolDb.deleteAndCompareTxsNotInList(rawMempool, { keepOnly: mayDelete !== true })
        // Commit as the store-commit lock's writer so no address read sees half of it.
        await withStoreCommit(this, async () => {
            await this.mempoolDb.endTransaction()
            // The epoch is a freshness token pagers compare between pages, so it moves
            // only when the prune removed rows. An idle 60 s pass deletes nothing; bumping
            // here made every long paged walk restart although nothing it reads changed.
            // New txs bump it when their batch commits.
            if (deletedInfo.transactionsDeleted || deletedInfo.inputsDeleted || deletedInfo.outputsDeleted) this.mempoolEpoch++
            if (rawMempool.length) this.mempoolReconverged = false
        })
        // rawMempool now holds only the txs the store still lacks, so the
        // store is a partial snapshot until the last batch lands. Withdraw
        // readiness left over from the previous pass;
        // markMempoolReconverged re-asserts it after the final batch.
        counts.deletedTransactionsCount = deletedInfo.transactionsDeleted
        counts.deletedInputsCount = deletedInfo.inputsDeleted
        counts.deletedOutputsCount = deletedInfo.outputsDeleted
    } catch (err){
        // Close the prune transaction before rethrowing so the batch
        // loop below never starts on top of a half-open transaction.
        try { await this.mempoolDb.endTransaction(false) } catch (_) {}
        throw err
    }
}

function logBatchEstimate(rawMempool){
    // Multi-batch passes are throttled by an inter-batch sleep; on a
    // large mempool the cumulative sleep dominates the wall-clock cost
    // of reconverging the in-memory mempool snapshot. Surface an estimate
    // up front so operators can correlate stale pending-balance windows
    // with mempool depth during fee spikes.
    if (rawMempool.length > MEMPOOL_BATCH_SIZE){
        let batchCount = Math.ceil(rawMempool.length / MEMPOOL_BATCH_SIZE)
        let estimatedSeconds = ((batchCount - 1) * MEMPOOL_INTER_BATCH_SLEEP) / 1000
        logger.info("Mempool update: "+batchCount+" batches required, estimated minimum reconvergence "+estimatedSeconds+"s")
    }
}

// A failed batch fetch, counted for get_sync_status and logged. The last
// failure allowed in a row throws instead, which ends the pass.
function noteTxFetchFailure(err, consecutiveTxFetchFailures){
    logger.info(err)
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
        logger.warn(nodeUtil.format("Giving up on this mempool pass after "+consecutiveTxFetchFailures+" consecutive getRawTransactions failures; will retry on the next interval.", err))
        throw new Error("mempool fetch incomplete after "+consecutiveTxFetchFailures+" consecutive getRawTransactions failures")
    }
    logger.info(nodeUtil.format("There was an error trying to get raw transactions from the mempool. Trying again...", err))
}

// Pending outputs are keyed on the txid the node listed, so the parse must hash to
// it. An MWEB-only tx (no transparent inputs or outputs) has no txid this parse can
// compute and nothing to stage, so it is skipped. Any other mismatch means the parse
// read different bytes than the node's, so it throws: the pass fails and readiness
// is withdrawn, as for a tx that does not parse at all.
function isStageableMempoolTx(tx, nodeTxid){
    if (tx.ins.length === 0 && tx.outs.length === 0) return false
    const computedTxid = tx.getId()
    if (computedTxid !== nodeTxid) {
        throw new Error('mempool tx ' + nodeTxid + ' parses to txid ' + computedTxid)
    }
    return true
}

// Parses and stages one fetched batch inside its own transaction, committed
// before the caller's inter-batch sleep so readers see it. nodeTxids is the
// batch's txid list; getRawTransactions answers in that order.
async function stageMempoolBatch(nextTxsHex, nodeTxids, rawMempool, counts){
    await this.mempoolDb.beginTransaction()
    try {
        for (let nextTxHexIndex in nextTxsHex){
            let nextTxHex = nextTxsHex[nextTxHexIndex]

            if (nextTxHex != null){
                let nextTx = this.xchainBlockDecoder.txFromHex(nextTxHex)
                if (!isStageableMempoolTx(nextTx, nodeTxids[nextTxHexIndex])) continue

                let countInfo = await this.parseTransaction(this.mempoolDb, nextTx, null, -1, true)

                if (counts.transactionsCount % MEMPOOL_BATCH_SIZE == 0){
                    logger.info(""+counts.transactionsCount+" parsed txs of "+rawMempool.length)
                }

                counts.transactionsCount = counts.transactionsCount + 1
                counts.inputsCount = counts.inputsCount + countInfo["inputsCount"]
                counts.outputsCount = counts.outputsCount + countInfo["outputsCount"]
            }
        }
        // Commit as the store-commit lock's writer so no address read sees half of it.
        await withStoreCommit(this, async () => {
            await this.mempoolDb.endTransaction()
            this.mempoolEpoch++
        })
    } catch (err){
        // Discard this batch's staged writes and rethrow to the
        // outer handler; mempoolBusy is cleared in finally.
        try { await this.mempoolDb.endTransaction(false) } catch (_) {}
        throw err
    }
}

function markMempoolReconverged(counts, mempoolStartTime){
    // Every batch that was fetched has been committed, so the in-memory
    // mempool DB now reflects the node mempool: readiness can be
    // asserted. Reset to false on any synced=false transition (see
    // above) and on mempool errors, which take the catch path below.
    this.mempoolReconverged = true
    let mempoolEndTime = Date.now()
    let timeString = this.millisecondsToTimeString(mempoolEndTime-mempoolStartTime)

    logger.info("Mempool updated!"
        +" Transactions ("+counts.transactionsCount+" more, "+counts.deletedTransactionsCount+" less)"
        +" Inputs ("+counts.inputsCount+" more, "+counts.deletedInputsCount+" less) "
        +" Outputs("+counts.outputsCount+" more, "+counts.deletedOutputsCount+" less) ["+timeString+"]")
}

function withdrawMempoolReadiness(error){
    // Any failure in the prune/parse/commit path (txFromHex on
    // malformed hex, a parseTransaction error, or a DB I/O fault) must
    // not leave mempoolBusy stuck true; otherwise every subsequent
    // setInterval tick bails with "Mempool is still busy" and the
    // mempool silently stagnates for the lifetime of the process. Each
    // phase above already closes its own transaction on error, so there
    // is nothing left open to roll back here.
    logger.error(nodeUtil.format('Error during mempool update: ' + error.message, error))
    // Every route into this catch leaves a post-prune snapshot that is
    // missing some advertised mempool txs, so readiness must be withdrawn
    // rather than left asserted from an earlier good pass. The
    // next successful pass re-asserts it at the end of the try block.
    this.mempoolReconverged = false
}
