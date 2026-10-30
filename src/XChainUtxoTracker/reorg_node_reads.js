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
const { logger } = require('./constants.js')
const { nodeStillCatchingUp, nodeTipIsParseable } = require('./catch_up_helpers.js')

// The reorg walk's reads of the node, called with the tracker as `this`;
// reorg_verification.js drives them.

// Returned by nodeBlockHashOrRetry once a failed hash fetch has been logged
// and slept on, to send the walk round again.
const RETRY_WALK = Symbol('retry the reorg walk')

// Fetches the node's hash at the committed height. A failed fetch is logged
// and slept on, `walk.tip` is re-read (refreshWalkTip below), and RETRY_WALK
// sends the walk round again. No retry cap: an unreachable node keeps the walk
// sleeping and retrying until it answers.
async function nodeBlockHashOrRetry(lastBlockIndex, walk){
    try {
        return await this.connector.getBlockHash(lastBlockIndex)
    } catch (err){
        logger.error(nodeUtil.format('Error fetching block hash from node: ' + err.message, err))
        await this.sleep(3000)
        walk.tip = await refreshWalkTip.call(this, walk.tip)
        return RETRY_WALK
    }
}

// Pause between tip readings, how many consecutive unchanged re-reads make a
// lower tip stable, and the total re-read budget. Shared with the sync loop's
// tip check (sync_loop_node_tip.js), which applies the same rule at walk entry.
const TIP_SETTLE_DELAY_MS = 2000
const TIP_SETTLE_STABLE_READS = 5
const TIP_SETTLE_MAX_READS = 10

// Re-reads the node's tip after a failed hash fetch (usually a tip that dropped
// below the walk). An unusable reading keeps the current tip; a higher one is
// taken at once, and a lower or first-ever one, which every block above it is
// deleted against, only after a full stable window, as the sync loop's check does.
async function refreshWalkTip(currentTip){
    const tip = await readWalkTip.call(this)
    if (tip === null) return currentTip
    let next = tip
    if (currentTip === null || tip < currentTip){
        next = await settleWalkTip.call(this, tip)
        if (next === null) return currentTip
    }
    if (next !== currentTip){
        logger.warn("verifyReorg: the node's tip moved mid-walk (" + (currentTip === null ? "unknown" : currentTip)
            + " -> " + next + "); heights above it are rolled back without asking the node.")
    }
    return next
}

// One usable tip reading, or null when the node cannot be read, answers no
// integer height, is below the parse gate or is still in initial block download.
async function readWalkTip(){
    if (!this.connector || typeof this.connector.getBlockchainInfo !== 'function') return null
    let info
    try {
        info = await this.connector.getBlockchainInfo()
    } catch (_){
        return null
    }
    if (!info || !Number.isInteger(info["blocks"])) return null
    if (!nodeTipIsParseable(info, this.consensusNetwork) || nodeStillCatchingUp(info)) return null
    return info["blocks"]
}

// Requires an unchanged tip for the full settle window. A single repeated
// reading is not enough: invalidateblock can pause at an intermediate height
// longer than TIP_SETTLE_DELAY_MS before continuing. Returns the settled tip,
// or null when a re-read is unusable or the total budget expires, so the walk
// keeps its current tip and retries.
async function settleWalkTip(first){
    let previous = first
    let stableReads = 0
    for (let read = 0; read < TIP_SETTLE_MAX_READS; read++){
        await this.sleep(TIP_SETTLE_DELAY_MS)
        const tip = await readWalkTip.call(this)
        if (tip === null) return null
        if (tip === previous){
            stableReads++
            if (stableReads === TIP_SETTLE_STABLE_READS) return tip
        } else {
            previous = tip
            stableReads = 0
        }
    }
    logger.warn("verifyReorg: the node tip is still moving after " + TIP_SETTLE_MAX_READS + " readings (last "
        + previous + "); keeping the walk's tip and retrying.")
    return null
}

module.exports = {
    RETRY_WALK,
    nodeBlockHashOrRetry,
    TIP_SETTLE_DELAY_MS,
    TIP_SETTLE_STABLE_READS,
    TIP_SETTLE_MAX_READS
}
