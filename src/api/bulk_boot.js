'use strict'

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
 * XChain UTXO Tracker - interruptible bulk-sync boot
 *
 * The bulk-sync loader writes LAST_BLOCK_HEIGHT last. If its process tree is
 * killed by the container runtime, the next boot sees the partial target as
 * empty and the loader then refuses to overlay it. This controller lets the
 * API entry point own the child process tree and restore an interrupted target
 * to the empty state while retaining the resumable work directory.
 *
 ********************************************************************/

const fs = require('fs')
const path = require('path')

const PROCESS_GROUP_POLL_MS = 25

function assertSafeDbPath(dbPath){
    if (typeof dbPath !== 'string' || !path.isAbsolute(dbPath)
        || path.dirname(dbPath) === dbPath) {
        throw new TypeError('bulk boot requires a non-root absolute dbPath')
    }
}

function defaultSignalChild(child, signal){
    if (!child) return
    if (process.platform !== 'win32' && Number.isInteger(child.pid) && child.pid > 0) {
        try {
            process.kill(-child.pid, signal)
            return
        } catch (err) {
            if (!err || err.code !== 'ESRCH') throw err
        }
    }
    if (typeof child.kill === 'function') child.kill(signal)
}

function defaultProcessGroupAlive(child){
    if (process.platform === 'win32' || !child
        || !Number.isInteger(child.pid) || child.pid <= 0) return false
    try {
        process.kill(-child.pid, 0)
        return true
    } catch (err) {
        if (err && err.code === 'ESRCH') return false
        if (err && err.code === 'EPERM') return true
        throw err
    }
}

function pause(ms){
    return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForProcessGroupExit(child, {
    isAlive = defaultProcessGroupAlive,
    wait = pause,
    pollMs = PROCESS_GROUP_POLL_MS
} = {}){
    while (isAlive(child)) await wait(pollMs)
}

function createDelayGate(isStopping){
    const waiters = new Set()
    return {
        wait(ms){
            if (isStopping()) return Promise.resolve(false)
            return new Promise((resolve) => {
                const waiter = {
                    timer: setTimeout(() => {
                        waiters.delete(waiter)
                        resolve(true)
                    }, ms),
                    resolve
                }
                waiters.add(waiter)
            })
        },
        wake(){
            for (const waiter of waiters) {
                clearTimeout(waiter.timer)
                waiter.resolve(false)
            }
            waiters.clear()
        }
    }
}

function trackChild(state, child, exitError){
    if (!child || typeof child.once !== 'function') {
        throw new TypeError('bulk boot requires a child-process-like value')
    }
    if (state.active) throw new Error('bulk boot already has an active child')
    if (state.stopping) {
        state.signal(child, 'SIGTERM')
        return Promise.reject(new Error('bulk boot stopped before child start'))
    }

    const record = { child, settled: false, promise: null }
    record.promise = new Promise((resolve, reject) => {
        const finish = (err) => {
            if (record.settled) return
            record.settled = true
            if (state.active === record) state.active = null
            if (err) reject(err)
            else resolve()
        }
        child.once('exit', (code, childSignal) => {
            if (code === 0) finish()
            else finish(exitError
                ? exitError(code, childSignal)
                : new Error(childSignal ? `child killed by ${childSignal}` : `child exited with code ${code}`))
        })
        child.once('error', finish)
    })
    state.active = record
    return record.promise
}

function stopBulkBoot(state){
    if (state.stopPromise) return state.stopPromise
    state.stopping = true
    state.delays.wake()
    const interrupted = state.active && !state.active.settled ? state.active : null
    state.stopPromise = (async () => {
        if (!interrupted) return
        state.logger.log('[bulk-sync] stop requested; terminating orchestrator process group')
        state.signal(interrupted.child, 'SIGTERM')
        try { await interrupted.promise } catch (_) {}
        await state.waitForGroup(interrupted.child)
        await state.cleanup()
        state.logger.log(`[bulk-sync] removed interrupted target ${state.dbPath}; resumable work files retained`)
    })()
    return state.stopPromise
}

/**
 * Track the mutable part of bulk-sync boot so SIGTERM can drain it.
 *
 * @param {object} opts
 * @param {string} opts.dbPath final LevelDB directory
 * @param {function} [opts.signalChild] process-tree signal seam
 * @param {function} [opts.waitForProcessGroup] process-group drain seam
 * @param {function} [opts.removeDb] interrupted-target cleanup seam
 * @param {object} [opts.log] console-shaped logger
 */
function createBulkBoot({ dbPath, signalChild, waitForProcessGroup, removeDb, log } = {}){
    assertSafeDbPath(dbPath)
    const state = {
        dbPath,
        signal: signalChild || defaultSignalChild,
        waitForGroup: waitForProcessGroup || waitForProcessGroupExit,
        cleanup: removeDb || (() => fs.rmSync(dbPath, { recursive: true, force: true })),
        logger: log || console,
        active: null,
        stopping: false,
        stopPromise: null,
        delays: null
    }
    state.delays = createDelayGate(() => state.stopping)

    return {
        delay: (ms) => state.delays.wait(ms),
        trackChild: (child, exitError) => trackChild(state, child, exitError),
        stop: () => stopBulkBoot(state),
        get stopping(){ return state.stopping },
        get child(){ return state.active && state.active.child }
    }
}

module.exports = {
    createBulkBoot,
    defaultProcessGroupAlive,
    defaultSignalChild,
    waitForProcessGroupExit
}
