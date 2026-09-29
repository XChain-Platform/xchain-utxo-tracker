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

const { SATOSHI_BIGINT, MIN_VERIFICATION_PROGRESS_TO_PARSE } = require('./constants.js')


// Exact satoshi -> decimal-string conversion: takes SATOSHIS, returns COIN units
// (a fixed-8 decimal string). Plain float division (value / 1e8)
// loses precision once a total exceeds Number.MAX_SAFE_INTEGER (e.g. DOGE balances
// above ~90M), so all balance/amount formatting goes through this BigInt path.
// The return value is display-denominated: never feed it back into a satoshi field.
function satoshiToDecimalString(satoshis) {
    const val = BigInt(satoshis)
    const abs = val < 0n ? -val : val
    const whole = abs / SATOSHI_BIGINT
    const frac = abs % SATOSHI_BIGINT
    return (val < 0n ? '-' : '') + whole.toString() + '.' + frac.toString().padStart(8, '0')
}


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


// Whether a getblockchaininfo reply says the node is still in initial block
// download. The 0.99 progress gate above admits a node thousands of blocks
// short of the tip, and while it is still catching up a node tip BELOW the
// committed tip is not a rollback: the node has not yet validated blocks this
// index already holds. Strict === true: an absent field (an older node, a
// trimmed proxy) keeps the pre-existing behaviour.
function nodeStillCatchingUp(info){
    return !!info && info["initialblockdownload"] === true
}


// The state published on the health surfaces for ONE poll of that wait. Heights
// are refreshed every poll so an operator can watch the node close the gap;
// `since` is carried over from the first poll of the same wait, so its age is
// the length of THIS wait and not the age of the last poll. `previous` is the
// value already on the instance: null on the first poll of a wait and after any
// wait that has ended.
function catchUpWaitState(previous, nodeHeight, storedHeight){
    return {
        node_height:   nodeHeight,
        stored_height: storedHeight,
        since:         (previous && previous.since) ? previous.since : new Date().toISOString()
    }
}

module.exports = { satoshiToDecimalString, nodeTipIsParseable, nodeStillCatchingUp, catchUpWaitState }
