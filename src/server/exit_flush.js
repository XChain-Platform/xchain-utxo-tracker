/* Copyright © 2025-2026 Dankest, LLC; SPDX-License-Identifier: AGPL-3.0-or-later */
'use strict'

// The log shipper only enqueues; a line reaches the collector when a batch fills
// or its interval timer fires. An exit that follows a line closely (the shutdown
// drain's last line, a CRASH record) would drop it, so every deliberate exit goes
// through here and gives the shipper a bounded chance to drain what it holds.

const DEFAULT_FLUSH_TIMEOUT_MS = 2000

let flusher = null

// `fn` ships what the log shipper has buffered, resolving once it has tried.
function registerLogFlush(fn) {
    flusher = typeof fn === 'function' ? fn : null
}

function shipperFlusher(shipper) {
    return async () => {
        const tracked = shipper && typeof shipper.stop === 'function' &&
            Array.isArray(shipper.buffer) && shipper.stats
        const shipped = tracked ? shipper.stats.shipped : 0
        const failures = tracked ? shipper.stats.failures : 0
        if (shipper && typeof shipper.stop === 'function') await shipper.stop()
        if (!tracked) return undefined
        return {
            remaining: shipper.buffer.length,
            progressed: shipper.stats.shipped > shipped,
            failed: shipper.stats.failures > failures,
            batchSize: shipper.config && shipper.config.batchSize
        }
    }
}

function isFlushStatus(status) {
    return status && Number.isInteger(status.remaining) && status.remaining >= 0
}

async function drainRegisteredFlusher(expired) {
    let status = await flusher()
    if (!isFlushStatus(status)) {
        if (!expired()) await flusher()
        return
    }
    const batchSize = Number.isInteger(status.batchSize) && status.batchSize > 0 ? status.batchSize : 100
    const maxPasses = Math.ceil(status.remaining / batchSize) + 2
    let passes = 1
    while (!expired() && passes < maxPasses && status.remaining > 0 &&
           status.progressed && !status.failed) {
        status = await flusher()
        passes++
        if (!isFlushStatus(status)) return
    }
}

// Never rejects and never waits past `timeoutMs`: an unreachable collector must
// not hold up a restart. Status-aware flushers drain successful batches and stop
// on failure, no progress, a pass cap or the deadline.
async function flushLogs(timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS) {
    if (!flusher) return
    let timer
    let expired = false
    const bound = new Promise((resolve) => {
        timer = setTimeout(() => { expired = true; resolve() }, timeoutMs)
    })
    const work = drainRegisteredFlusher(() => expired).catch(() => {})
    await Promise.race([work, bound])
    clearTimeout(timer)
}

function exitAfterFlush(code, { exit = (c) => process.exit(c), timeoutMs, shouldExit = () => true } = {}) {
    return flushLogs(timeoutMs).then(() => { if (shouldExit()) exit(code) })
}

module.exports = { registerLogFlush, shipperFlusher, flushLogs, exitAfterFlush, DEFAULT_FLUSH_TIMEOUT_MS }
