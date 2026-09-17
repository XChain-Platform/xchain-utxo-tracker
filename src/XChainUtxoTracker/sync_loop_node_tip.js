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

// Node's own util, under a second name: `util` is this repo's helper
// module, and the logger folds a variadic console line through format().
const nodeUtil = require('node:util')
const { CHECK_BLOCK_DELAY_MS, MEMPOOL_INTERVAL, MIN_VERIFICATION_PROGRESS_TO_PARSE, P_PENDING_CLEANUP_KEY, logger } = require('./constants.js')
const { nodeStillCatchingUp, catchUpWaitState } = require('./catch_up_helpers.js')
const { indexNextBlock, resetBatchAfterReorg } = require('./sync_loop_block_apply.js')

// Whether this node's tip is worth parsing. Pure and exported so the policy is
// testable without a loop or a node.

// bitcoind derives verificationprogress from the WALL-CLOCK AGE of the tip
// block, so on a chain mined on demand it decays toward 0 while the node stays
// healthy. On regtest the premise fails, so the gate is dropped, not re-tuned.

// Nothing replaces it there, and specifically not initialblockdownload:
// nodeStillCatchingUp() reads that flag on the tip-BELOW-ours path, and
// consuming it here would end the pass first and swallow the catch-up wait.

// A regtest tracker genuinely behind its node is still reported: the synced
// verdict comes from the two heights, and a node that cannot answer
// getblockchaininfo at all still leaves lastNodeRpcOkAt unstamped below.

// The `< MIN` comparison keeps its original form so an ABSENT field (an older
// node, a trimmed proxy) still reads usable instead of inverting to a refusal.
function nodeTipIsParseable(info, consensusNetwork){
    if (!info) return false
    if (consensusNetwork === 'regtest') return true
    return !(info["verificationprogress"] < MIN_VERIFICATION_PROGRESS_TO_PARSE)
}

// Sync loop steps, called with the tracker as `this`; sync_loop.js says how.

// Reads the node's tip. An unsynced node or a failed RPC is waited out and ends
// the pass; a usable tip is stamped and the pass goes on to reconcile it.
async function refreshNodeTip(sync){
    try {
        sync.lastBlockchainInfo = await this.connector.getBlockchainInfo()
        this.latestKnownChainTip = sync.lastBlockchainInfo["blocks"]

        if (!nodeTipIsParseable(sync.lastBlockchainInfo, this.consensusNetwork)){
            if (!sync.nodeSyncedProblem){
                logger.info("The node is not synced. Waiting for it to synchronize...")
            }

            sync.lastBlockchainInfo = null
            sync.nodeSyncedProblem = true
            await this.sleep(3000)
            return
        } else {
            sync.nodeSyncedProblem = false
        }

        this.blockchainInfoLastBlock = sync.lastBlockchainInfo["blocks"]
        sync.lastBlockchainInfoRefreshAt = Date.now()
        // Stamped only here, past the verification-progress gate, so
        // "node RPC ok" means a USABLE tip: an unsynced node that answers
        // and a node that does not answer both age this timestamp out.
        // Never stamped in the catch below.
        this.lastNodeRpcOkAt = sync.lastBlockchainInfoRefreshAt
    } catch (e){
        logger.error(nodeUtil.format('Error fetching blockchain info from node: ' + e.message, e))
        await this.sleep(3000)
        return
    }
    return reconcileRefreshedTip.call(this, sync)
}

// After a tip refresh: end a catch-up wait the node's tip has closed, then
// recover from a node tip below ours, or go on to the tip or the next block.
function reconcileRefreshedTip(sync){
    const { lastProcessedBlockIndex } = sync
    // The usual way a catch-up wait ends: the node's tip reached ours,
    // so the branch below is not entered at all and the published wait
    // would otherwise stay on the health surfaces for the rest of the
    // process. Only the state is cleared here; the latched log lines are
    // left to their own transition below.
    if (this.nodeCatchingUp && lastProcessedBlockIndex <= this.blockchainInfoLastBlock){
        this.nodeCatchingUp = null
    }

    if (lastProcessedBlockIndex > this.blockchainInfoLastBlock){
        return recoverFromTipBelowOurs.call(this, sync)
    }
    return pollAtTipOrIndex.call(this, sync)
}

// At the node's tip, wait there; behind it, index the next block.
function pollAtTipOrIndex(sync){
    //If there is no new block, wait for some seconds to ask again
    if (sync.lastProcessedBlockIndex == this.blockchainInfoLastBlock){
        return pollAtChainTip.call(this, sync)
    }
    return indexNextBlock.call(this, sync)
}

// A node still in initial block download has not validated up
// to our height yet; its tip below ours is a node catching up,
// not a rollback. Wait for it to pass the committed tip and let
// the forward hash compare decide. Same hazard the decoder hit
// on an operator's fresh BTC mainnet node 2026-09-07: walking
// back here spends the whole undo window on a reorg that never
// happened and halts for a rebuild. Publishes the wait and sleeps.
async function waitOnCatchingUpNode(sync){
    const { lastProcessedBlockIndex } = sync
    if (!sync.nodeCatchingUpProblem){
        logger.warn("WARNING! The last processed block height ("+lastProcessedBlockIndex+") is greater than the last block from the network ("+this.blockchainInfoLastBlock+"), but the node reports initialblockdownload=true: it is still catching up, not rolled back. Waiting for it to pass "+lastProcessedBlockIndex+" instead of rolling back; the hash compare decides then.")
    }
    sync.nodeCatchingUpProblem = true
    // Publish it; past the latched line the wait is invisible.
    this.nodeCatchingUp = catchUpWaitState(this.nodeCatchingUp,
        this.blockchainInfoLastBlock, lastProcessedBlockIndex)
    await this.sleep(5000)
}

// Our committed tip is above the node's: wait while the node is still catching
// up; otherwise discard any open batch, read the committed block, and either
// roll back onto the node's chain or repair the stored tip pointer.
async function recoverFromTipBelowOurs(sync){
    const { lastBlockchainInfo, lastProcessedBlockIndex } = sync
    if (nodeStillCatchingUp(lastBlockchainInfo)) return waitOnCatchingUpNode.call(this, sync)
    if (sync.nodeCatchingUpProblem){
        logger.info("The node has left initial block download with its tip ("+this.blockchainInfoLastBlock+") still below the last processed block ("+lastProcessedBlockIndex+"); treating the gap as a rollback from here on.")
        sync.nodeCatchingUpProblem = false
        this.nodeCatchingUp = null
    }

    // Discard any in-flight batch before recovery runs. A
    // periodic refresh can reach here mid-batch; leaving the staged
    // batch open would leak phantom UTXOs or break per-block atomicity
    // once verifyReorg opens its own transaction. Rationale in full at
    // discardInflightBatchForReorg(). Zero the batch counters here
    // since they live in the loop's state, not on the instance.
    if (await this.discardInflightBatchForReorg(sync.blocksQuantity)){
        sync.blocksQuantity = 0
        sync.blocksCount = 0
        sync.transactionsCount = 0
        sync.inputsCount = 0
        sync.outputsCount = 0
        sync.pendingMempoolTxCleanup = []
        sync.blockTimestamps = []
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
        return rollBackToNodeTip.call(this, sync, lastBlockDb)
    }
    return repairLastBlockPointer.call(this, sync, lastBlockDb)
}

// True regression: the node's tip is genuinely below our committed
// tip (node reset / reindex / invalidateblock). Roll back onto the
// node's chain instead of warn-and-spin. Without this we fall through,
// try to fetch block N+1 the node doesn't have, loop forever, and keep
// serving the orphaned tip's UTXOs. verifyReorg(nodeTip) deletes the
// blocks above the node tip, then reconciles by hash, honoring the
// undoBlocks depth guard (a regression deeper than the window aborts
// loudly for an operator-driven resync).
async function rollBackToNodeTip(sync, lastBlockDb){
    // console.warn, not console.log: the line says WARNING but a
    // collector keys severity on the console method, so at info level
    // this tip regression is filed as routine progress. See the
    // reorg-detection-warn-level drift guard.
    if (!sync.tipBelowCommittedTipRefused){
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
            if (!sync.tipBelowCommittedTipRefused){
                logger.error(err.message)
            }
            sync.tipBelowCommittedTipRefused = true
            await this.sleep(5000)
            return
        }
        throw err
    }
    sync.tipBelowCommittedTipRefused = false
    sync.lastProcessedBlockIndex = await this.db.getLastBlockHeight()
    sync.lastProcessedBlockHash = await this.db.getLastBlockHash()
}

// The node's tip is below our in-memory cursor but not below the committed
// block: point the stored tip back at that block. Hands back the cursor move.
async function repairLastBlockPointer(sync, lastBlockDb){
    // Same repair as verifyReorg's, and it needs the same own
    // batch: bare setters STAGE, and at boot they stage into the
    // constructor Map nothing commits, which makes the log line
    // below claim a fix that never reaches disk. The
    // discardInflightBatchForReorg() call above satisfies the
    // precondition. Rationale at commitLastBlockPointerRepair().
    await this.commitLastBlockPointerRepair(lastBlockDb.hash, lastBlockDb.height)
    return () => {
        sync.lastProcessedBlockIndex = lastBlockDb.height
        sync.lastProcessedBlockHash = lastBlockDb.hash
        logger.info("Last block index was fixed!")
    }
}

// Synced at the node's tip: re-check the committed tip for a same-height reorg,
// start the mempool poller once, and wait before asking again.
async function pollAtChainTip(sync){
    this.synced = true

    // Same-height tip reorg detection. While synced we otherwise never
    // re-check the committed tip hash, so a node that replaces its tip at
    // the same height and then stalls would have us keep serving the
    // orphaned block's UTXOs until a new height arrives. Cheaply re-compare
    // the committed tip hash against the node each synced poll; on a
    // mismatch drive verifyReorg to roll back to the common ancestor.
    if (sync.lastProcessedBlockIndex > 0){
        let tipHashFromNode = null
        try {
            tipHashFromNode = await this.connector.getBlockHash(sync.lastProcessedBlockIndex)
        } catch (err){
            logger.error(nodeUtil.format('Error re-checking the committed tip hash from node: ' + err.message, err))
        }
        if (tipHashFromNode && tipHashFromNode != sync.lastProcessedBlockHash){
            return rollBackSameHeightTipSwap.call(this, sync)
        }
    }

    if (this.mempoolInterval == null){
        logger.info("Mempool updates started!")
        this.updateMempool()
        this.mempoolInterval = setInterval(this.updateMempool.bind(this), MEMPOOL_INTERVAL)
    }

    await this.sleep(CHECK_BLOCK_DELAY_MS)
}

// The node swapped our committed tip at the same height: discard the open
// batch and roll back to the common ancestor. Hands back the batch reset.
async function rollBackSameHeightTipSwap(sync){
    // console.warn: a tip swap at the same height is a reorg, and it
    // must leave a warn-level record even if verifyReorg then wedges
    // before reorgCount/last_reorg_depth advance.
    logger.warn("A same-height tip reorg has been detected. Cleaning blocks...")
    sync.prefetchQueue = []
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
    sync.lastProcessedBlockIndex = await this.db.getLastBlockHeight()
    sync.lastProcessedBlockHash = await this.db.getLastBlockHash()
    // Run the deferred K/M/W cleanup now (cleanupAgedBlocks skips any
    // hash still in the reloaded live window) and delete the P key
    // atomically, then zero the batch counters so the next block opens
    // a fresh batch.
    await this.cleanupAgedBlocks()
    return () => resetBatchAfterReorg.call(this, sync)
}

module.exports = { refreshNodeTip, pollAtTipOrIndex, nodeTipIsParseable }
