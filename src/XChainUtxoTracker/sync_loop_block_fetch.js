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

const { BLOCK_FETCH_RETRY_SLEEP_MS, PREFETCH_SIZE, logger } = require('./constants.js')

// Sync loop steps, called with the tracker as `this`; sync_loop.js says how.

// Queues batched fetches for the heights after the queue's last entry, up to
// PREFETCH_SIZE entries and never past the node's tip.
function fillPrefetchQueue(sync, fromHeight, tipHeight){
    let maxQueued = fromHeight - 1
    if (sync.prefetchQueue.length > 0) {
        maxQueued = sync.prefetchQueue[sync.prefetchQueue.length - 1].height
    }

    // Collect all heights that still need to be queued
    const heights = []
    while (sync.prefetchQueue.length + heights.length < PREFETCH_SIZE && maxQueued + 1 <= tipHeight) {
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
            sync.prefetchQueue.push({ height: h, promise: p })
        })
    } else {
        // Non-AuxPoW: one batch HTTP request for all getblockhash + one for all getblock
        const batchPromise = this.connector.getBlocksBatch(heights)
        heights.forEach((h, i) => {
            const p = batchPromise.then(results => ({ hash: results[i].hash, hex: results[i].hex }))
            p.catch(() => {}) // suppress unhandled rejection if entry is cleared from queue before being awaited
            sync.prefetchQueue.push({ height: h, promise: p })
        })
    }
}

// One block by height, outside the prefetch queue.
async function fetchBlock(height){
    const hash = await this.connector.getBlockHash(height)
    const hex = this.auxPow
        ? await this.connector.getBlockWithoutAuxPow(hash)
        : await this.connector.getBlock(hash)
    return { hash, hex }
}

// The next block's hash and bytes: rebuilt per-tx once the AuxPoW strip keeps
// failing at this height, else from the prefetch queue, else fetched directly.
// On a failure it counts both streaks, waits, and returns null (the pass ends);
// the fetch streak throws once the node plainly cannot serve the block.
async function fetchNextBlock(sync, nextBlockHeight){
    let nextBlockHash = null
    let nextBlockHex = null
    try {
        let fetched
        if (this.shouldReassembleBlock(nextBlockHeight, sync.auxPowParseFailureHeight, sync.auxPowParseFailures)) {
            // The AuxPoW STRIP has failed this many times at this height,
            // which is evidence about the block's bytes rather than the
            // node's health: bypass the prefetch queue (its batch strip
            // would just fail the same way) and rebuild the pure block
            // per-tx, never reading the AuxPoW bytes.
            logger.error('AuxPoW strip at height ' + nextBlockHeight + ' failed ' + sync.auxPowParseFailures +
                ' consecutive times; falling back to per-tx block reassembly (malformed-AuxPoW recovery).')
            sync.prefetchQueue = []
            const hash = await this.connector.getBlockHash(nextBlockHeight)
            fetched = { hash, hex: await this.connector.getBlockReassembled(hash) }
        } else if (sync.prefetchQueue.length > 0 && sync.prefetchQueue[0].height === nextBlockHeight) {
            fetched = await sync.prefetchQueue.shift().promise
        } else {
            // Queue is out of sync (e.g. after reorg), fetch directly
            sync.prefetchQueue = []
            fetched = await fetchBlock.call(this, nextBlockHeight)
        }
        nextBlockHash = fetched.hash
        nextBlockHex = fetched.hex
        // Successful fetch: clear the desync streak so a future
        // transient blip starts counting from zero again, and the
        // parse streak with it (this block's bytes are readable, by
        // the strip or by reassembly).
        sync.blockFetchFailures = 0
        sync.blockFetchFailureHeight = null
        sync.auxPowParseFailures = 0
        sync.auxPowParseFailureHeight = null
    } catch (e){
        sync.prefetchQueue = []
        // noteBlockFetchFailure counts consecutive failures at this
        // height and THROWS a diagnosable desync error once the bound
        // is hit, so a node pruned past our cursor fails loud instead
        // of spinning every 3s forever. It counts EVERY failure; the
        // parse streak beside it counts only the tagged content faults
        // that may escalate to reassembly.
        const _p = this.noteAuxPowParseFailure(nextBlockHeight, sync.auxPowParseFailureHeight, sync.auxPowParseFailures, e)
        sync.auxPowParseFailureHeight = _p.height
        sync.auxPowParseFailures = _p.count
        const _s = this.noteBlockFetchFailure(nextBlockHeight, sync.blockFetchFailureHeight, sync.blockFetchFailures, e)
        sync.blockFetchFailureHeight = _s.height
        sync.blockFetchFailures = _s.count
        await this.sleep(BLOCK_FETCH_RETRY_SLEEP_MS)
        return null
    }
    return { hash: nextBlockHash, hex: nextBlockHex }
}

module.exports = { fillPrefetchQueue, fetchNextBlock }
