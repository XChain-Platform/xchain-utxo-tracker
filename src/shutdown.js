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
 * XChain UTXO Tracker - Graceful shutdown
 *
 * Bounded, idempotent drain for SIGTERM/SIGINT, the same shape as the
 * indexer's and decoder's src/shutdown.js. The Dockerfile CMD runs node as
 * PID 1, so `docker stop` delivers SIGTERM here; see the CMD comment there
 * for why `npm run api` hid this (npm was PID 1, node was never told).
 *
 * Before this file the tracker had no handler: node's default action killed
 * the block loop wherever it stood, and the container exited 1 (measured by
 * an operator with `docker stop -t 180`, 2026-09-10). A block is one atomic
 * LevelDB batch and the mempool store is in memory, so the kill lost no
 * committed state; what it lost was the ordered close of the store, the
 * listener, and an exit code that says anything.
 *
 * Registering a handler REMOVES node's default terminate, so the handler
 * carries its own hard-exit timer: a drain that hangs must still end the
 * process, or a stop becomes a container that lingers under any supervisor
 * with a long grace period, which is strictly worse than the kill.
 *
 ********************************************************************/

// Hard-exit budget for the whole drain. xchain-node stops a tracker with a
// 120 s budget (and stamps it on the container as --stop-timeout), so the
// default sits under that: an overrun that ends in our own logged exit is
// diagnosable, one that ends in the daemon's SIGKILL is not. On a container
// created before the budget existed docker's ten seconds still applies.
// SHUTDOWN_TIMEOUT_MS overrides for a slow chain.
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 100000

function resolveTimeoutMs(timeoutMs, env){
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) return timeoutMs
    const raw = parseInt((env || process.env).SHUTDOWN_TIMEOUT_MS, 10)
    return (Number.isFinite(raw) && raw > 0) ? raw : DEFAULT_SHUTDOWN_TIMEOUT_MS
}

// Close an http.Server and resolve once it has stopped listening. Idle keep-alive
// sockets would otherwise hold close() open indefinitely while no request is in
// flight, so they are dropped explicitly; requests already being served finish.
function closeServer(server){
    return new Promise((resolve) => {
        if (!server || typeof server.close !== 'function') return resolve()
        let settled = false
        const done = () => { if (!settled){ settled = true; resolve() } }
        try {
            server.close(done)
            if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections()
        } catch (_){
            done()
        }
    })
}

// Best-effort close of a set of store handles, deduped by identity. The block
// loop closes the main store itself on its way out, so the main store usually
// arrives here already closed; a store that refuses must not abort the drain.
async function closeStores(handles, log){
    const logger = log || console
    const seen = new Set()
    for (const store of (handles || [])){
        if (!store || typeof store.close !== 'function' || seen.has(store)) continue
        seen.add(store)
        try { await store.close() }
        catch (err){ logger.warn('Shutdown: closing a store failed: ' + (err && err.message ? err.message : err)) }
    }
}

/**
 * Build an idempotent signal handler that runs `drain` under a hard-exit bound.
 *
 * @param {object}   opts
 * @param {function} opts.drain      async work to finish before exiting
 * @param {number}   [opts.timeoutMs] hard-exit budget (default SHUTDOWN_TIMEOUT_MS / 100000)
 * @param {function} [opts.exit]     process-exit seam (tests pass their own)
 * @param {object}   [opts.log]      console-shaped logger
 * @returns {function(string): void} handler to register on SIGTERM / SIGINT
 */
function createShutdown({ drain, timeoutMs, exit, log } = {}){
    const onExit  = exit || ((code) => process.exit(code))
    const logger  = log || console
    const budget  = resolveTimeoutMs(timeoutMs)
    let signalled = false

    return function shutdown(signal){
        // A second signal must not restart the sequence: re-entering would close
        // the store underneath a drain already using it.
        if (signalled){
            logger.log('Shutdown already in progress; ignoring ' + (signal || 'signal') + '.')
            return
        }
        signalled = true
        logger.log('Received ' + (signal || 'signal') + ', draining (hard exit in ' + budget + 'ms)...')

        let finished = false
        const timer = setTimeout(() => {
            if (finished) return
            finished = true
            // Non-zero: the drain did NOT complete, so work was cut off exactly as a
            // SIGKILL would have cut it. A clean drain below exits 0.
            logger.error('Shutdown drain exceeded ' + budget + 'ms; exiting hard.')
            onExit(1)
        }, budget)

        Promise.resolve().then(() => drain()).then(
            () => {
                if (finished) return
                finished = true
                clearTimeout(timer)
                logger.log('Shutdown drain complete; exiting.')
                onExit(0)
            },
            (err) => {
                if (finished) return
                finished = true
                clearTimeout(timer)
                logger.error('Shutdown drain failed:', err)
                onExit(1)
            }
        )
    }
}

/**
 * The tracker's drain, as its own function so the exit path is unit-testable.
 *
 * Order is load-bearing:
 *   1. stop() the tracker: keepParsing goes false and the mempool poller is
 *      cleared. The block loop takes its else branch at its next check, which
 *      is a block boundary, closes the main store and breaks, so start()
 *      resolves.
 *   2. drain the HTTP server and the block loop together.
 *   3. close the stores LAST (the main store is normally closed by the loop
 *      already; the halted-for-resync case, where the loop is gone and never
 *      reached its else branch, is what this close is for).
 *
 * The wait on step 2 is unbounded HERE and bounded by the caller's hard-exit
 * timer, because both ways it can overrun (a 200-block commit slower than the
 * budget, or a boot still restoring) should end in a logged non-zero exit.
 *
 * @param {object}   opts
 * @param {object}   opts.tracker      XChainUtxoTracker instance
 * @param {object}   opts.server       http.Server returned by app.listen()
 * @param {Promise}  [opts.loopSettled] promise that settles when start()'s loop exits
 * @param {object}   [opts.log]        console-shaped logger
 */
function createTrackerDrain({ tracker, server, loopSettled, log } = {}){
    const logger = log || console
    return async function drain(){
        if (tracker && typeof tracker.stop === 'function') tracker.stop()

        await Promise.all([
            closeServer(server),
            // start() resolves when the block loop breaks on keepParsing. It is
            // already .catch()'d at the call site (a fatal error exits 1 there, a
            // halt keeps the process up), so a rejection here is that same handled
            // error and must not fail the drain.
            Promise.resolve(loopSettled).catch(() => {})
        ])

        await closeStores(tracker ? [tracker.db, tracker.mempoolDb] : [], logger)
    }
}

module.exports = {
    DEFAULT_SHUTDOWN_TIMEOUT_MS,
    resolveTimeoutMs,
    closeServer,
    closeStores,
    createShutdown,
    createTrackerDrain
}
