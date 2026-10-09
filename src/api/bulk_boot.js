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

/**
 * Track the mutable part of bulk-sync boot so SIGTERM can drain it.
 *
 * @param {object} opts
 * @param {string} opts.dbPath final LevelDB directory
 * @param {function} [opts.signalChild] process-tree signal seam
 * @param {function} [opts.removeDb] interrupted-target cleanup seam
 * @param {object} [opts.log] console-shaped logger
 */
function createBulkBoot({ dbPath, signalChild, removeDb, log } = {}){
    assertSafeDbPath(dbPath)
    const signal = signalChild || defaultSignalChild
    const cleanup = removeDb || (() => fs.rmSync(dbPath, { recursive: true, force: true }))
    const logger = log || console
    const delayWaiters = new Set()
    let active = null
    let stopping = false
    let stopPromise = null

    function delay(ms){
        if (stopping) return Promise.resolve(false)
        return new Promise((resolve) => {
            const waiter = {
                timer: setTimeout(() => {
                    delayWaiters.delete(waiter)
                    resolve(true)
                }, ms),
                resolve
            }
            delayWaiters.add(waiter)
        })
    }

    function wakeDelays(){
        for (const waiter of delayWaiters) {
            clearTimeout(waiter.timer)
            waiter.resolve(false)
        }
        delayWaiters.clear()
    }

    function trackChild(child, exitError){
        if (!child || typeof child.once !== 'function') {
            throw new TypeError('bulk boot requires a child-process-like value')
        }
        if (active) throw new Error('bulk boot already has an active child')
        if (stopping) {
            signal(child, 'SIGTERM')
            return Promise.reject(new Error('bulk boot stopped before child start'))
        }

        const record = { child, settled: false, promise: null }
        record.promise = new Promise((resolve, reject) => {
            const finish = (err) => {
                if (record.settled) return
                record.settled = true
                if (active === record) active = null
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
        active = record
        return record.promise
    }

    async function stop(){
        if (stopPromise) return stopPromise
        stopping = true
        wakeDelays()
        const interrupted = active && !active.settled ? active : null

        stopPromise = (async () => {
            if (!interrupted) return
            logger.log('[bulk-sync] stop requested; terminating orchestrator process group')
            signal(interrupted.child, 'SIGTERM')
            try { await interrupted.promise } catch (_) {}
            await cleanup()
            logger.log(`[bulk-sync] removed interrupted target ${dbPath}; resumable work files retained`)
        })()
        return stopPromise
    }

    return {
        delay,
        trackChild,
        stop,
        get stopping(){ return stopping },
        get child(){ return active && active.child }
    }
}

module.exports = { createBulkBoot, defaultSignalChild }
