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
 * XChain UTXO Tracker - Mempool readiness generation
 *
 ********************************************************************/

// A mempool pass lists the node mempool once and then stages it over many
// batches, so readiness can be withdrawn (a reorg, falling behind the node, a
// halt, a stop) while a pass is mid-flight. That pass listed the mempool before
// the withdrawal, so its store may miss what the event changed and it must not
// assert readiness when it ends. Every withdrawal outside a pass goes through
// revokeMempoolReadiness, which also moves the generation; a pass records the
// generation when it starts and asserts readiness only while it is unchanged.
// A pass's own reset of the flag before it stages is not a withdrawal and does
// not move the generation.

// Called with the tracker as `this`; a tracker without the counter reads as 0.
function readinessGeneration(){
    return this.mempoolReadinessGen || 0
}

function revokeMempoolReadiness(){
    this.mempoolReconverged = false
    this.mempoolReadinessGen = readinessGeneration.call(this) + 1
}

module.exports = { readinessGeneration, revokeMempoolReadiness }
