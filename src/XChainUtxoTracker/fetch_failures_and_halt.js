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
const { AUXPOW_REASSEMBLE_AFTER, MAX_BLOCK_FETCH_RETRIES, logger } = require('./constants.js')

module.exports = {
    // Decides whether the block-fetch loop should stop retrying the AuxPoW strip
    // path for this height and rebuild the block per-tx instead.
    //
    // The streak this reads is the AUXPOW-PARSE streak, never the generic
    // block-fetch streak, and the difference is the whole point. Reassembly fans
    // out one getrawtransaction RPC per transaction in the block; escalating on a
    // transport fault would aim that fan-out at the node that is already failing
    // to answer. Only a fault in the strip itself is evidence that THIS BLOCK's
    // bytes are the problem, and the connector tags exactly those with
    // auxPowParseFailure (getBlockWithoutAuxPow and the per-block strip inside
    // getBlocksBatchWithoutAuxPow). The decoder twin has counted the two
    // separately since its own escalation misfired on ~15s of node
    // unavailability; see xchain-decoder/src/XChainDecoder.js.
    shouldReassembleBlock(height, streakHeight, streakCount){
        return !!this.auxPow && streakHeight === height && streakCount >= AUXPOW_REASSEMBLE_AFTER
    },

    // Advance the AuxPoW-parse streak for a failure at `height`. Same streak
    // shape as noteBlockFetchFailure (counts while the SAME height keeps failing,
    // restarts on a height change), but an UNTAGGED error leaves the count where
    // it is rather than clearing it: a node that flaps mid-recovery must not
    // rewind progress toward the reassembly that fixes a genuinely malformed
    // block. Only a success clears it, at the call site.
    noteAuxPowParseFailure(height, streakHeight, streakCount, error){
        // A failure at a NEW height starts a new streak, counted only if it is the
        // AuxPoW parse failure the reassembly path exists to fix.
        if (streakHeight !== height) return { height: height, count: (error && error.auxPowParseFailure) ? 1 : 0 }
        // Any other failure at the same height leaves the count where it is, so a
        // flapping node cannot rewind progress toward the reassembly.
        if (!(error && error.auxPowParseFailure)) return { height: streakHeight, count: streakCount }
        return { height: height, count: streakCount + 1 }
    },

    // Evaluate a block-fetch failure at `height`. `streakHeight`/`streakCount`
    // are the caller's running streak; the count increments while the SAME height
    // keeps failing and resets to 1 on a height change (we advanced past the stuck
    // block). Once MAX_BLOCK_FETCH_RETRIES consecutive failures accrue at one
    // height, the node cannot serve that block (pruned past our cursor, or a
    // permanent missing-block fault): record a diagnosable desync state on the
    // instance (surfaced by get_sync_status) and THROW so the polling loop's
    // top-level guard records a CRASH and exits for a supervised restart, instead of
    // retrying every few seconds forever with no signal. Returns the updated
    // { height, count } streak for the caller to carry forward on a non-fatal miss.
    //
    // This counts EVERY failure, transport included: "can the node serve this
    // block at all" is a different question from noteAuxPowParseFailure's "are
    // this block's bytes the problem", and only the latter may escalate.
    noteBlockFetchFailure(height, streakHeight, streakCount, error){
        const count = (streakHeight === height) ? streakCount + 1 : 1
        const msg = error && error.message ? error.message : String(error)
        logger.error(nodeUtil.format('Error fetching block at height ' + height + ' (attempt ' + count + '/' + MAX_BLOCK_FETCH_RETRIES + '): ' + msg, error))
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
    },

    // Enter a stable halted state instead of exiting on an unrecoverable reorg.
    // Exiting lets Docker's restart policy relaunch us into the identical failure
    // every ~15s forever (the observed 5000+ restart crash-loop). Halting keeps
    // the process up so /status reports 503 (unhealthy, not falsely healthy) and
    // get_sync_status carries the reason, and the operator can run restorebootstrap
    // against a process that is not restarting under them. The tracker does NOT
    // auto-wipe: rebuilding the UTXO set needs a resync from a known-good snapshot,
    // an operator decision. Called from api.js's top-level start() guard.
    // Returns the promise of the marker write so a caller that wants the halt
    // durable before it continues (the start() guard) can await it; the in-memory
    // state is set synchronously and does not depend on the write landing.
    haltForResync(reason){
        this.enterHaltedState({
            reason: reason || 'unrecoverable reorg (rolled back past the recovery window)',
            at: new Date().toISOString(),
            height: null
        })
        logger.error('[halted] xchain-utxo-tracker stopped polling: ' + this.haltReason
            + ' - process kept alive for an operator resync (restorebootstrap); NOT auto-wiping. '
            + '/status now returns 503 and get_sync_status.halted=true.')
        return this.persistHaltMarker()
    },

    // Clear the halt once a restore has REPLACED the on-disk store the halt was
    // declared against, so /status and get_sync_status stop reporting a fault that no
    // longer describes the data and xchain-node's BootstrapHealthGate can accept this
    // source again. Deliberately not called from start() or from the snapshot-only
    // getbootstrap relaunch: there the data is unchanged, so an un-halt would publish
    // healthy over the same bad tip until the loop re-detects the reorg, and the gate's
    // lag budget cannot catch that window because a deep reorg leaves lag near zero.
    // A restored snapshot that is itself bad simply re-halts when the loop re-detects.
    // Returns the promise of the marker delete; the state clears synchronously.
    clearHalt(){
        this.halted = false
        this.haltReason = null
        this.haltedAt = null
        this.haltedHeight = null
        return this.deleteHaltMarker()
    },

    // Report, at boot, that the undo window came back SHORT of the nominal
    // undoBlocks, and say WHICH of the two things that can mean happened.
    //
    // 1. A rollback interrupted mid-reorg. Every rollback deletes one N record
    //    and only forward sync puts them back, so the window is below a depth it
    //    HAD reached. Without this line the reorg that resumes a moment later
    //    reads as a fresh fault, and the halt that may follow looks like it
    //    arrived out of nowhere at a depth far shallower than the fork's real one.
    // 2. The window has never been that deep: UNDO_BLOCKS was RAISED under an
    //    existing store (LTC's per-chain default went 48 -> 120 on 2026-09-01,
    //    and the LTC mainnet tracker then booted "48 of 120" and called it a
    //    72-block rollback that Litecoin mainnet never had). Nothing rolled back;
    //    the window refills one slot per forward-synced block.
    //
    // The watermark is what separates them: a window at or above the deepest this
    // store ever held never shrank. Below it, the shortfall against the WATERMARK
    // (not against undoBlocks) is what the previous process actually rolled back.
    // A store with no watermark yet cannot be told apart, so it says so instead of
    // asserting the interrupted-rollback reading, and records the mark for next boot.
    //
    // Warn only for case 1 and the ambiguous case: a collector keys severity on
    // the console method, and a window refilling after a raise is routine
    // progress, where a WARNING is the false alarm this method exists to stop.
    // Skipped below the window's own depth, where short just means a short chain.
    // Returns the surviving budget when it reported, else null (for tests).
    noteInterruptedReorgWindow(committedHeight){
        // Below the window's own depth a short window just means a short chain,
        // which is normal and not worth a warning.
        if (!(committedHeight >= this.undoBlocks)) return null
        // A full window is the healthy case: nothing was interrupted.
        if (this.lastBlocks.length >= this.undoBlocks) return null
        const remaining = this.lastBlocks.length
        const watermark = Math.min(this.undoWindowWatermark || 0, this.undoBlocks)
        const tail = "Only " + remaining + " more blocks can be walked back onto the node's chain "
            + "before this index has to be rebuilt."

        if (watermark > 0 && remaining >= watermark){
            logger.info("The undo window came back with " + remaining + " of " + this.undoBlocks
                + " blocks. Nothing was rolled back: this store has never held more than " + watermark
                + ", so the window is still refilling toward a raised UNDO_BLOCKS (one slot per block "
                + "synced). " + tail)
            return remaining
        }

        if (watermark === 0){
            logger.warn("WARNING! The undo window came back with " + remaining + " of " + this.undoBlocks
                + " blocks. This store predates the undo-window watermark, so the two causes cannot be "
                + "told apart here: either a previous process was interrupted mid-reorg, or UNDO_BLOCKS "
                + "was raised under an existing store and the window is still refilling. The watermark is "
                + "being recorded from now on, so the next boot names which. " + tail)
            return remaining
        }

        logger.warn("WARNING! The undo window came back with " + remaining + " of " + this.undoBlocks
            + " blocks, so a previous process was interrupted mid-reorg after rolling back "
            + (watermark - remaining) + " of the " + watermark + " this store had reached. " + tail)
        return remaining
    }
}
