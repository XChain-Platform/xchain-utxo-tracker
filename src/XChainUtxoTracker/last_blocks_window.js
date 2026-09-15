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

const { Q_UNDO_WATERMARK_KEY, P_PENDING_CLEANUP_KEY } = require('./constants.js')
const XChainUtxoTracker = require('../XChainUtxoTracker.js')

module.exports = {
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

        await this.recordUndoWindowWatermark()
    },

    // Keep the persisted high-water mark of the undo window in step with the
    // window this block just left behind. Staged into the caller's open batch
    // (addLastStoredBlock above opened nothing of its own), so the mark commits
    // atomically with the N record it describes and a crash cannot leave a mark
    // deeper than the window on disk.
    //
    // Writes are rare by construction: only while a window is still filling
    // toward undoBlocks, plus one write after the operator LOWERS the window (the
    // clamp applied on load is flushed back so disk stops carrying the old, now
    // misleading depth). At the cap the depth stops changing and so do the writes.
    recordUndoWindowWatermark(){
        const depth = Math.min(this.lastBlocks.length, this.undoBlocks)
        if (depth > this.undoWindowWatermark) this.undoWindowWatermark = depth
        // Nothing to write when the depth on disk already matches: this runs every
        // block, and a store write per block for an unchanged number is pure cost.
        if (this.undoWindowWatermarkPersisted === this.undoWindowWatermark) return
        this.undoWindowWatermarkPersisted = this.undoWindowWatermark
        return this.db.addTransaction("put", Q_UNDO_WATERMARK_KEY,
            Buffer.from(String(this.undoWindowWatermark)))
    },

    // Read the watermark back at boot, clamped to the live undoBlocks. A missing
    // key (a store written before the mark existed) reads as 0, which is what
    // noteInterruptedReorgWindow reports the ambiguity from.
    async loadUndoWindowWatermark(){
        let stored = 0
        try {
            const raw = await this.db.db.get(Q_UNDO_WATERMARK_KEY)
            if (raw !== undefined){
                const parsed = parseInt(raw.toString(), 10)
                if (Number.isInteger(parsed) && parsed > 0) stored = parsed
            }
        } catch (_) {
            // A store that cannot answer for this one diagnostic key must not stop
            // the tracker from booting: 0 (unknown) is the safe reading.
        }
        this.undoWindowWatermarkPersisted = stored > 0 ? stored : null
        this.undoWindowWatermark = Math.min(stored, this.undoBlocks)
        return this.undoWindowWatermark
    },

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
            // Leave a block alone while it is still inside the recovery window: its
            // recovery records are exactly what a reorg would need.
            if (liveWindow.has(blockHash)) continue
            // And clean each block once: the same hash can be queued twice in one pass.
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
    },

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
        // No blocks staged means there is no batch to throw away.
        if (blocksQuantity <= 0) return false
        await this.db.endTransaction(false)
        if (this.pendingKMCleanup.length > 0) {
            await this.db.db.put(P_PENDING_CLEANUP_KEY,
                Buffer.from(JSON.stringify(this.pendingKMCleanup)))
        }
        this.pendingKMCleanup = []
        return true
    },

    async removeFromLastBlocks(blockHash){
        // Guard against the empty-list edge case: when lastBlocks is empty,
        // indexOf returns -1 and length-1 is also -1, making the condition
        // true and silently pop()-ing undefined instead of throwing. An empty
        // list means we have rolled back past the tracked window, which is an
        // error that should abort rather than silently corrupt state.
        if (this.lastBlocks.length === 0){
            // verifyReorg's budget guard normally fires before the window can run
            // dry and it names the remedy, so this is the last resort: a caller
            // that drives a rollback without a maintained window at all. Carry the
            // same remedy anyway - the pre-fix message stopped at "list is empty",
            // which told the litecoin-testnet operator nothing about what to do and
            // sent them into a non-destructive recreate that hit the same wall.
            throw XChainUtxoTracker.markUnrecoverableReorg(new Error(
                "Can't delete a block from 'last blocks': list is empty (reorg exceeds tracked window). "
                + "This index cannot be walked back onto the node's chain and has to be rebuilt. Under "
                + "xchain-node run `xchain-node reset xchain-utxo-tracker <coin> <network>`, which drops the "
                + "volume and takes the bulk-sync path; standalone, stop the tracker, empty its data "
                + "directory and restart it. Restoring the same bootstrap again lands back here if its tip "
                + "is the drifted one."))
        }
        if (this.lastBlocks.indexOf(blockHash) == this.lastBlocks.length-1){
            this.lastBlocks.pop()
            await this.db.removeLastStoredBlock(blockHash)
        } else {
            throw new Error("Can't delete a block from the 'last blocks' if it's not the last one")
        }
    },

    // getLastStoredBlocks() returns the stored-block hashes in blockHash
    // (lexicographic) order, but the reorg path (removeFromLastBlocks) requires
    // lastBlocks to be in ascending HEIGHT order with the chain tip last.
    // Without sorting, a reorg throws "Can't delete a block from the 'last
    // blocks'…" and wedges the sync loop. Each block's height comes from its
    // B-prefix record; this is at most UNDO_BLOCKS lookups (per-chain
    // DEFAULT_UNDO_BLOCKS, e.g. BTC=12/LTC=120/DOGE=120, not a fixed 10).
    async loadLastBlocksSortedByHeight(){
        const storedHashes = await this.db.getLastStoredBlocks()
        const withHeight = []
        for (const hash of storedHashes){
            const blk = await this.db.getBlock(hash)
            withHeight.push({ hash, height: blk ? blk.h : -1 })
        }
        withHeight.sort((a, b) => a.height - b.height)
        return withHeight.map(b => b.hash)
    },

    // Commit a LAST_BLOCK_* pointer repair in its OWN batch so it reaches disk
    // before the caller re-reads getLastBlockHeight/Hash (which read disk only).
    //
    // setLastBlockHash/Height STAGE into transactionArray rather than writing
    // through, and at boot that array is the still-open constructor Map that no
    // flush ever commits: a repair written without this ends up discarded by the
    // next beginTransaction, leaving the durable pointer above the node tip while
    // the in-memory cursor reads correct. Every disk-reading consumer then
    // disagrees with the loop (get_sync_status / computeFreshness floor `synced`
    // to false on the negative lag), and if the loop then sleeps synced nothing
    // ever flushes, so the wrong pointer persists across restarts.
    //
    // PRECONDITION, and it is why this is one method rather than two copies:
    // beginTransaction() REPLACES transactionArray outright, so the caller must
    // have discarded or committed any in-flight batch first. verifyReorg's callers
    // all do; start()'s repair branch does it through
    // discardInflightBatchForReorg() immediately above the call.
    async commitLastBlockPointerRepair(hash, height){
        await this.db.beginTransaction()
        await this.db.setLastBlockHash(hash)
        await this.db.setLastBlockHeight(height)
        await this.db.endTransaction()
    }
}
