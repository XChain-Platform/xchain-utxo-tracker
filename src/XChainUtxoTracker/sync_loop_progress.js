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

const LevelUpStore = require('../store/level_up_db.js')
const { ETA_WINDOW_BLOCKS, logger } = require('./constants.js')
const XChainUtxoTracker = require('../XChainUtxoTracker.js')

// What a batch flush reports about sync progress, called with the tracker as
// `this`; sync_loop_block_apply.js runs them once the flush has committed.

// The flush's timing line (per-phase milliseconds, the parse and known-script
// buckets, memory), after which every bucket starts again from zero.
function logBatchTiming(sync, _flushReason, _earlyFlushHeapMB){
    const _t = sync._t
    // ── Print timing summary ──
    _t.blocks = sync.blocksQuantity + 1
    const _total = _t.decode + _t.parse + _t.commit + _t.cleanup
    const _pb = XChainUtxoTracker.parseOutBuckets
    const _pi = LevelUpStore.parseInBuckets
    const _ks = LevelUpStore.knownScripts
    const _ksH = LevelUpStore.knownScriptsHits
    const _ksM = LevelUpStore.knownScriptsMisses
    const _ksRate = _ksH + _ksM > 0 ? ((_ksH / (_ksH + _ksM)) * 100).toFixed(1) : '0.0'
    const _mem = process.memoryUsage()
    const _heapMB = (_mem.heapUsed / 1048576).toFixed(0)
    const _rssMB = (_mem.rss / 1048576).toFixed(0)
    const _ocSize = LevelUpStore.outputCache.size
    logger.info(`⏱ TIMING (${_t.blocks} blocks) flush=${_flushReason} total=${_total}ms | decode=${_t.decode}ms | parse=${_t.parse}ms (out=${_t.parseOut}ms [hash=${_pb.hash}ms ins=${_pb.ins}ms sb=${_pb.sb}ms] in=${_t.parseIn}ms [hintRead=${_pi.hintRead}ms outRead=${_pi.outRead}ms stage=${_pi.stage}ms]) | commit=${_t.commit}ms | cleanup=${_t.cleanup}ms | knownScripts=${_ks.size} hit=${_ksH} miss=${_ksM} rate=${_ksRate}% | heap=${_heapMB}MB heapPre=${_earlyFlushHeapMB.toFixed(0)}MB rss=${_rssMB}MB outCache=${_ocSize}`)
    XChainUtxoTracker.parseOutBuckets = { hash: 0, ins: 0, sb: 0 }
    LevelUpStore.parseInBuckets = { hintRead: 0, outRead: 0, stage: 0 }
    LevelUpStore.knownScriptsHits = 0
    LevelUpStore.knownScriptsMisses = 0
}

// Adds this flush to the rolling ETA window, then zeroes the batch's timings and
// counters.
function recordSyncProgress(sync, nextBlockHeight){
    // Rolling ETA based on tx throughput; window is a span of
    // ETA_WINDOW_BLOCKS blocks, not a count of samples. Each sample
    // covers DB_TRANSACTION_BLOCKS_QUANTITY blocks, so a count-based
    // trim would keep ~200× more history than intended.
    sync.blockTimestamps.push({height: nextBlockHeight, time: Date.now(), txCount: sync.transactionsCount})
    while (sync.blockTimestamps.length >= 2 &&
           (nextBlockHeight - sync.blockTimestamps[0].height) > ETA_WINDOW_BLOCKS) {
        sync.blockTimestamps.shift()
    }

    sync._t = { fetch: 0, decode: 0, parse: 0, parseOut: 0, parseIn: 0, commit: 0, cleanup: 0, blocks: 0 }
    sync.blocksCount = 0
    sync.transactionsCount = 0
    sync.inputsCount = 0
    sync.outputsCount = 0
}

// Throughput and the estimated time to the node's tip, once the ETA window
// holds two flushes.
function logSyncEta(sync, nextBlockHeight){
    const blockTimestamps = sync.blockTimestamps
    let blocksLeft = this.blockchainInfoLastBlock - nextBlockHeight
    if (blocksLeft > 0 && blockTimestamps.length >= 2) {
        let oldest = blockTimestamps[0]
        let newest = blockTimestamps[blockTimestamps.length - 1]
        let totalTx = 0
        for (let k = 1; k < blockTimestamps.length; k++) totalTx += blockTimestamps[k].txCount
        let elapsedMs = newest.time - oldest.time
        let msPerTx = elapsedMs / totalTx
        let avgTxPerBlock = totalTx / (newest.height - oldest.height)
        let msLeft = blocksLeft * avgTxPerBlock * msPerTx
        logger.info(`⚡ Speed: ${(1000/msPerTx).toFixed(1)} tx/s | avg ${avgTxPerBlock.toFixed(0)} tx/block (last ${newest.height - oldest.height} blocks)`)
        logger.info("Estimated time to finish: "+this.millisecondsToTimeString(msLeft))
    }
}

module.exports = { logBatchTiming, recordSyncProgress, logSyncEta }
