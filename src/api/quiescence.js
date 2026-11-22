/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************/
'use strict'

// Quiescence probe: ready=true iff the node-side mempool is empty (no unmined
// txs the tracker is blind to until the next MEMPOOL_INTERVAL poll) and the
// node tip equals the tracker's last-committed height (which is naturally
// false mid-batch). Callers poll it between e2e tests as a barrier so the next
// test starts from a fully-settled stack.
//
// The method is unauthenticated and holds a request-gate slot, so it must not
// let a slow node pin that slot or the connector's shared socket pool. The two
// node reads run in parallel under one deadline, and at most one probe per
// tracker has node reads outstanding. A caller that finds one outstanding is
// answered not-ready at once instead of joining it: a barrier answer has to
// rest on reads issued after the caller arrived, and a joined read can predate
// the state the caller is waiting on.
let nodeDeadlineMs = 5000

function configureQuiescenceDeadlineMs(value) {
    nodeDeadlineMs = value
}

const probesInFlight = new WeakSet()

function mempoolSizeOf(mempool) {
    if (Array.isArray(mempool)) return mempool.length
    return (mempool && typeof mempool === 'object') ? Object.keys(mempool).length : 0
}

// Starts both node reads and resolves to their settled results, or to null when
// the deadline passes first. The in-flight mark clears only when the reads
// themselves settle, so a deadline never frees the sockets for another probe.
async function probeNode(tracker, deadlineMs) {
    const reads = Promise.allSettled([
        Promise.resolve().then(() => tracker.connector.getRawMempool()),
        Promise.resolve().then(() => tracker.connector.getBlockchainInfo())
    ])
    probesInFlight.add(tracker)
    reads.then(() => probesInFlight.delete(tracker))
    let timer
    const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(null), deadlineMs) })
    try {
        return await Promise.race([reads, deadline])
    } finally {
        clearTimeout(timer)
    }
}

async function isQuiescent(tracker, deadlineMs = nodeDeadlineMs) {
    let mempoolSize = -1
    let trackerHeight = -1
    let nodeHeight = -1
    if (!probesInFlight.has(tracker)) {
        const settled = await probeNode(tracker, deadlineMs)
        if (settled) {
            const [mempool, info] = settled
            if (mempool.status === 'fulfilled') mempoolSize = mempoolSizeOf(mempool.value)
            if (info.status === 'fulfilled') {
                nodeHeight = (info.value && typeof info.value.blocks === 'number') ? info.value.blocks : -1
            }
        }
    }
    try { trackerHeight = await tracker.db.getLastBlockHeight() } catch (e) { /* leave -1: not ready */ }
    const heightAligned = (nodeHeight >= 0 && trackerHeight >= 0 && nodeHeight === trackerHeight)
    return {
        ready:            heightAligned && mempoolSize === 0,
        mempool_size:     mempoolSize,
        committed_height: trackerHeight,
        tracker_height:   trackerHeight,
        node_height:      nodeHeight,
        lag:              (nodeHeight >= 0 && trackerHeight >= 0) ? (nodeHeight - trackerHeight) : null
    }
}

module.exports = { isQuiescent, configureQuiescenceDeadlineMs }
