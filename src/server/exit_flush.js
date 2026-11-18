/* Copyright © 2025-2026 Dankest, LLC; SPDX-License-Identifier: AGPL-3.0-or-later */
'use strict'

// The log shipper only enqueues; a line reaches the collector when a batch fills
// or its interval timer fires. An exit that follows a line closely (the shutdown
// drain's last line, a CRASH record) would drop it, so every deliberate exit goes
// through here and gives the shipper one bounded chance to send what it holds.

const DEFAULT_FLUSH_TIMEOUT_MS = 2000

let flusher = null

// `fn` ships what the log shipper has buffered, resolving once it has tried.
function registerLogFlush(fn) {
    flusher = typeof fn === 'function' ? fn : null
}

// Never rejects and never waits past `timeoutMs`: an unreachable collector must
// not hold up a restart. The shipper's stop() sends one batch, and when a batch
// send is already in flight it only awaits that one, so a second pass sends the
// batch queued behind it.
async function flushLogs(timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS) {
    if (!flusher) return
    let timer
    const bound = new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs) })
    const work = (async () => { await flusher(); await flusher() })().catch(() => {})
    await Promise.race([work, bound])
    clearTimeout(timer)
}

function exitAfterFlush(code, { exit = (c) => process.exit(c), timeoutMs } = {}) {
    return flushLogs(timeoutMs).then(() => exit(code))
}

module.exports = { registerLogFlush, flushLogs, exitAfterFlush, DEFAULT_FLUSH_TIMEOUT_MS }
