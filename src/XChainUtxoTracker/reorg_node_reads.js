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

// Re-reads the node's tip after a failed hash fetch, the usual cause being a
// tip that dropped below the walk (node restart onto a shorter chain, a second
// reorg). Trusts the reading no more than the sync loop's tip check does: a
// failed read, an unparseable tip or a node still in initial block download
// keeps the current tip, so a catching-up node is waited on, never rolled back.
async function refreshWalkTip(currentTip){
    if (!this.connector || typeof this.connector.getBlockchainInfo !== 'function') return currentTip
    let info
    try {
        info = await this.connector.getBlockchainInfo()
    } catch (_){
        return currentTip
    }
    if (!info || !Number.isInteger(info["blocks"])) return currentTip
    if (!nodeTipIsParseable(info, this.consensusNetwork) || nodeStillCatchingUp(info)) return currentTip
    if (info["blocks"] !== currentTip){
        logger.warn("verifyReorg: the node's tip moved mid-walk (" + (currentTip === null ? "unknown" : currentTip)
            + " -> " + info["blocks"] + "); heights above it are rolled back without asking the node.")
    }
    return info["blocks"]
}

module.exports = { RETRY_WALK, nodeBlockHashOrRetry }
