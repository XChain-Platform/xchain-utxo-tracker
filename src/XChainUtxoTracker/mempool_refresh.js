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

module.exports = {
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
                logger.error(nodeUtil.format('Error updating mempool: ' + error.message, error))
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
                    logger.info("Mempool update: "+batchCount+" batches required, estimated minimum reconvergence "+estimatedSeconds+"s")
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
                        logger.info(err)
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
                            logger.warn(nodeUtil.format("Giving up on this mempool pass after "+consecutiveTxFetchFailures+" consecutive getRawTransactions failures; will retry on the next interval.", err))
                            throw new Error("mempool fetch incomplete after "+consecutiveTxFetchFailures+" consecutive getRawTransactions failures")
                        }
                        logger.info(nodeUtil.format("There was an error trying to get raw transactions from the mempool. Trying again...", err))
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
                                    logger.info(""+transactionsCount+" parsed txs of "+rawMempool.length)
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

                logger.info("Mempool updated!"
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
                logger.error(nodeUtil.format('Error during mempool update: ' + error.message, error))
                // Every route into this catch leaves a post-prune snapshot that is
                // missing some advertised mempool txs, so readiness must be withdrawn
                // rather than left asserted from an earlier good pass. The
                // next successful pass re-asserts it at the end of the try block.
                this.mempoolReconverged = false
            } finally {
                this.mempoolBusy = false
            }
        } else {
            logger.info("Mempool is still busy")
        }
    }
}
