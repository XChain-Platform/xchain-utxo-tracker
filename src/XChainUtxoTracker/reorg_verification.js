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
const { REMOVE_SPENT, logger } = require('./constants.js')
const XChainUtxoTracker = require('../XChainUtxoTracker.js')

// Returned by nodeBlockHashOrRetry once a failed hash fetch has been logged
// and slept on, to send the walk round again.
const RETRY_WALK = Symbol('retry the reorg walk')

module.exports = {
    async verifyReorg(nodeTipHeight = null){
        let thereAreDifferences = true
        let blocksDeleted = []
        let retryCount = 0

        const undoWindow = rollbackBudget.call(this)

        while (thereAreDifferences){
            let lastBlockIndex = await this.db.getLastBlockHeight()
            let lastBlockHash = await this.db.getLastBlockHash()
            let lastBlock = await this.db.getBlock(lastBlockHash)
            logCommittedTip(lastBlockIndex, lastBlockHash, lastBlock)

            if (!lastBlock || (lastBlockIndex != lastBlock["h"])){
                let lastBlockDb = await repairLastBlockPointerFromScan.call(this, lastBlockIndex, lastBlock)
                logRepairedPointer(lastBlockDb)
                continue
            } else {
                // If the caller passed the node's current tip height and our committed
                // tip sits above it (node reset / reindex / invalidateblock regression),
                // those blocks cannot exist on the node's chain. Delete them directly
                // rather than asking the node for a hash at a height it no longer has
                // (which would error and spin this loop). Once the walk reaches the node
                // tip, the normal hash comparison below reconciles the common ancestor.
                let aboveNodeTip = (nodeTipHeight !== null && lastBlockIndex > nodeTipHeight)
                refuseAboveTipWalkPastBudget.call(this, aboveNodeTip, nodeTipHeight, lastBlockIndex, blocksDeleted, undoWindow.budget)

                let blockHashFromNode = null
                if (!aboveNodeTip){
                    blockHashFromNode = await nodeBlockHashOrRetry.call(this, lastBlockIndex)
                    if (blockHashFromNode === RETRY_WALK) continue
                    logger.info("Last block hash from node is "+blockHashFromNode)
                }

                if (aboveNodeTip || lastBlockHash != blockHashFromNode){
                    refuseRollbackPastWindow.call(this, undoWindow, lastBlockIndex, blocksDeleted)
                    if (!(await rollBackTipBlock.call(this, lastBlockHash, lastBlock, retryCount))){
                        retryCount++
                        continue
                    }
                    logger.info("Removed block "+lastBlockHash+" ("+lastBlock["h"]+")")
                    logger.info("Rollback to previous block "+lastBlock["ph"]+" ("+(lastBlock["h"]-1)+")")

                    // Per-block retry budget: reset after each successful rollback so the
                    // 10-attempt limit applies per block, not cumulatively across the whole
                    // reorg run. Otherwise a multi-block reorg with one transient failure per
                    // block could exhaust the budget and abort, leaving orphan blocks behind.
                    retryCount = 0
                    blocksDeleted.push({"block_index":lastBlockIndex, "block_hash":lastBlockHash})
                } else {
                    thereAreDifferences = false
                }
            }
        }

        recordReorg.call(this, blocksDeleted)

        return true
    },

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

// The walk's budget and the undo-window accounting its refusals report,
// fixed once at entry.
function rollbackBudget(){
    // ROLLBACK BUDGET. How far back this walk may go is bounded by the
    // spent-output recovery records (K/M), and those survive exactly for the
    // blocks the undo window still holds. The window is PERSISTED (the N
    // records) and every rollback deletes one of its entries, so an
    // interrupted reorg leaves it SHORT: the surviving window, not the
    // nominal per-chain undoBlocks, is what a restarted process can still
    // walk back.
    //
    // Deriving the budget from the window at entry makes it restart-safe: the
    // window IS the durable record of what was already spent. undoBlocks stays
    // as the upper cap so lowering the XCHAIN_UNDO_BLOCKS_<COIN> override still
    // tightens the walk rather than being ignored. An empty window at entry
    // carries no budget to derive: the first DIVERGENCE the walk meets refuses
    // with the depth guard's message (below), before any delete, while a walk
    // that finds no divergence still returns normally for the call sites that
    // drive verifyReorg without maintaining a window at all.
    const windowAtEntry = this.lastBlocks.length
    const budget = windowAtEntry > 0 ? Math.min(windowAtEntry, this.undoBlocks) : this.undoBlocks
    // What a previous process already spent out of this chain's window. Only
    // meaningful once the window is being maintained; reported so the halt
    // message states the fork's true depth rather than this pass's share of it.
    //
    // Measured against the WATERMARK (the deepest window this store has held,
    // clamped to undoBlocks), not against undoBlocks: a window that is short
    // only because UNDO_BLOCKS was raised under an existing store spent
    // nothing, and charging it the difference overstates the fork by exactly
    // the raise. A store with no watermark (0) falls back to the nominal
    // depth, which is the pre-watermark reading.
    const watermarkAtEntry = Math.min(this.undoWindowWatermark || 0, this.undoBlocks)
    const heldBefore = watermarkAtEntry > 0 ? watermarkAtEntry : this.undoBlocks
    const spentBeforeEntry = windowAtEntry > 0 ? Math.max(0, heldBefore - windowAtEntry) : 0
    return { windowAtEntry, budget, watermarkAtEntry, heldBefore, spentBeforeEntry }
}

// Logs the committed tip the walk is about to compare against the node.
function logCommittedTip(lastBlockIndex, lastBlockHash, lastBlock){
    logger.info("Last block index is "+lastBlockIndex)
    logger.info("Last block hash is "+lastBlockHash)
    logger.info("Last block height is "+(lastBlock?lastBlock["h"]:"null"))
}

// The last-block pointer and the block it names disagree, or that block is
// missing. Finds the real tip by scanning the block index and commits the
// repaired pointer, returning that tip; throws when the store cannot repair it.
async function repairLastBlockPointerFromScan(lastBlockIndex, lastBlock){
    //This shouldn't happen, but let's try to find the real lastBlockIndex
    logger.info("The blocks height for the same hash are not equal. Trying to fix the lastBlockIndex stored in db. This could take some minutes...")
    let lastBlockDb = await this.db.getLastBlock()
    logger.info("Last block from db is "+(lastBlockDb?lastBlockDb:"null"))

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

    // The pointer and the block it points at must agree on the height; if they
    // do not, the store is inconsistent and continuing would compound it.
    if (lastBlock && (lastBlockDb.height != lastBlock["h"])){
        throw Error("There are inconsistents in a block height. It should be "+lastBlockIndex+" but "+lastBlock["h"]+" was found")
    } else {
        // Own batch, or the re-read below sees the unrepaired pointer and
        // this branch spins forever. Rationale in full at
        // commitLastBlockPointerRepair(); all verifyReorg callers discard
        // any prior batch first, so opening a fresh one here strands nothing.
        await this.commitLastBlockPointerRepair(lastBlockDb.hash, lastBlockDb.height)
    }
    return lastBlockDb
}

// Logs the repaired pointer before the walk re-reads it.
function logRepairedPointer(lastBlockDb){
    logger.info("The new last block hash in the db is "+lastBlockDb.hash)
    logger.info("The new last block index in the db is "+lastBlockDb.height)
    logger.info("Last block index was fixed!")
}

function refuseAboveTipWalkPastBudget(aboveNodeTip, nodeTipHeight, lastBlockIndex, blocksDeleted, budget){
    // The above-tip walk knows its depth up front: every committed height
    // above the node tip is a rollback. When that alone (on top of what
    // this pass already walked back) would exhaust the budget, refuse NOW,
    // before the first delete, and WITHOUT the unrecoverable tag: nothing
    // has been walked back past the window, the index is intact and no
    // rebuild is owed. The depth guard below stays the authority once
    // deletes have happened. Tagged so the sync loop can wait on it
    // instead of exiting into a restart loop or halting for a rebuild.
    if (aboveNodeTip && blocksDeleted.length + (lastBlockIndex - nodeTipHeight) > budget){
        const aboveTip = lastBlockIndex - nodeTipHeight
        const msg = "verifyReorg: the node's tip (" + nodeTipHeight + ") is " + aboveTip
            + " blocks below the committed tip (" + lastBlockIndex + "), which"
            + (blocksDeleted.length > 0 ? " with " + blocksDeleted.length + " block(s) already rolled back" : "")
            + " exceeds the recovery window (" + budget + " of UNDO_BLOCKS=" + this.undoBlocks
            + " available). Refusing before any further rollback: nothing has been walked back past "
            + "the window, the index is intact and no rebuild is needed. Either the node is still "
            + "catching up (wait for it to pass " + lastBlockIndex + ") or it was rolled back below "
            + "this index's tip (operator action)."
        const err = new Error(msg)
        err.tipBelowCommittedTip = true
        throw err
    }
}

// Fetches the node's hash at the committed height. A failed fetch is logged
// and slept on, and RETRY_WALK sends the walk round again.
async function nodeBlockHashOrRetry(lastBlockIndex){
    try {
        return await this.connector.getBlockHash(lastBlockIndex)
    } catch (err){
        logger.error(nodeUtil.format('Error fetching block hash from node: ' + err.message, err))
        await this.sleep(3000)
        return RETRY_WALK
    }
}

function refuseRollbackPastWindow(undoWindow, lastBlockIndex, blocksDeleted){
    const { windowAtEntry, budget, watermarkAtEntry, heldBefore, spentBeforeEntry } = undoWindow
    // Depth guard: spent-output recovery records (K/M entries) are
    // retained only for the most recent UNDO_BLOCKS blocks;
    // cleanupAgedBlocks() purges them once a block ages out of that
    // window. Once we have already rolled back UNDO_BLOCKS blocks, the
    // next block's recovery records are gone, so processDeletedOutputs(
    // hash, true) would silently restore nothing and leave the UTXO
    // index permanently under-counted for any address with outputs spent
    // in those blocks. A loud abort is strictly safer than a silently
    // corrupt index: stop here and require an operator-driven resync.
    // An EMPTY window at entry is the same fault at depth zero: the
    // previous process spent every slot, so the very first divergence
    // is already past the window. Refuse here with the same message
    // rather than falling through to removeFromLastBlocks' generic
    // empty-list guard, which cannot state how deep the fork was.
    if (windowAtEntry === 0 || blocksDeleted.length >= budget){
        const msg = this.reorgExceedsWindowMessage({
            windowAtEntry, watermarkAtEntry, heldBefore, spentBeforeEntry, lastBlockIndex,
            deletedThisPass: blocksDeleted.length
        })
        logger.error(msg)
        throw XChainUtxoTracker.markUnrecoverableReorg(new Error(msg))
    }
}

// Rolls the committed tip back one block in its own batch. Resolves true once
// the batch commits and false after a failed attempt is logged and slept on;
// rethrows an unrecoverable reorg and gives up on the tenth failure.
async function rollBackTipBlock(lastBlockHash, lastBlock, retryCount){
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
        return true
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
        logger.error(nodeUtil.format(`verifyReorg: failed to delete block ${lastBlock["h"]} (${lastBlockHash}): ${err.message}`, err))
        // Ten failed deletes of the same block is not a blip any more: stop and say so
        // rather than retry forever against a store that will not accept the write.
        if (retryCount + 1 >= 10) throw new Error('verifyReorg: deleteBlockByIndex failed after 10 attempts, aborting')
        await this.sleep(3000)
        return false
    }
}

// Counts a finished reorg for get_sync_status: how many, and the last depth.
function recordReorg(blocksDeleted){
    if (blocksDeleted.length > 0){
        logger.info(blocksDeleted.length+" blocks were removed")
        this.reorgCount++
        this.lastReorgDepth = blocksDeleted.length
    }
}
