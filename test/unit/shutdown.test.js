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
 **********************************************************************/

// Pins the container exit path. `docker stop` sends SIGTERM to node (PID 1 via the
// Dockerfile's exec-form CMD) and this drain is everything between that signal and
// the process ending. Before it existed there was no handler and npm was PID 1, so
// node died wherever it stood and the container exited 1.

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const sinon = require('sinon')
const { createShutdown, createTrackerDrain, closeServer, closeStores, resolveTimeoutMs, DEFAULT_SHUTDOWN_TIMEOUT_MS } = require('../../src/shutdown')
const XChainUtxoTracker = require('../../src/XChainUtxoTracker')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// Turn the event loop a bounded number of times. The tracker/server doubles below
// resolve their callbacks with setImmediate, so a handful of macrotask turns is
// strictly more than a drain needs to reach its await - with no wall clock in it.
const flushMacrotasks = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }
async function waitUntil(predicate, timeoutMs = 5000, intervalMs = 10){
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline){
        if (await predicate()) return true
        await sleep(intervalMs)
    }
    return Boolean(await predicate())
}

const silentLog = { log(){}, warn(){}, error(){} }

// Minimal tracker stand-in: records call ORDER, because the ordering is the
// contract (stop before the server drains, stores closed last).
function makeTracker(order){
    let resolveLoop
    const loop = new Promise((res) => { resolveLoop = res })
    const store = (name) => ({
        closed: false,
        async close(){ this.closed = true; order.push('close:' + name) }
    })
    return {
        stopped: false,
        db:        store('db'),
        mempoolDb: store('mempoolDb'),
        loop,
        // The real stop() only drops keepParsing; the loop breaks at its next
        // check, which the test models by resolving the loop promise later.
        stop(){ this.stopped = true; order.push('stop'); setImmediate(resolveLoop) }
    }
}

function makeServer(order){
    return {
        closed: false,
        idleDropped: false,
        close(cb){ this.closed = true; order.push('server.close'); setImmediate(cb) },
        closeIdleConnections(){ this.idleDropped = true }
    }
}

describe('graceful shutdown', function(){

    describe('createShutdown', function(){

        it('runs the drain and exits zero when it completes', async function(){
            const codes = []
            let drained = false
            const shutdown = createShutdown({ drain: async () => { drained = true }, exit: (c) => codes.push(c), log: silentLog })
            shutdown('SIGTERM')
            assert.ok(await waitUntil(() => codes.length > 0), 'timed out waiting for the clean drain to reach exit()')
            assert.strictEqual(drained, true)
            assert.deepStrictEqual(codes, [0])
        })

        it('is idempotent: a second signal does not re-enter the drain', async function(){
            const codes = []
            let calls = 0
            const shutdown = createShutdown({ drain: async () => { calls++; await sleep(20) }, exit: (c) => codes.push(c), log: silentLog })
            shutdown('SIGTERM')
            shutdown('SIGTERM')
            shutdown('SIGINT')
            assert.ok(await waitUntil(() => codes.length > 0), 'timed out waiting for the single in-flight drain to reach exit()')
            assert.strictEqual(calls, 1, 'drain must run exactly once')
            assert.deepStrictEqual(codes, [0])
        })

        it('hard-exits non-zero when the drain overruns its budget', async function(){
            const codes = []
            const shutdown = createShutdown({ drain: () => new Promise(() => {}), timeoutMs: 20, exit: (c) => codes.push(c), log: silentLog })
            shutdown('SIGTERM')
            assert.ok(await waitUntil(() => codes.length > 0), 'timed out waiting for the hard-exit timer to fire')
            assert.deepStrictEqual(codes, [1])
        })

        it('exits non-zero when the drain throws, and only once', async function(){
            const codes = []
            // The budget timer is the second exit path, so the claim is that nothing
            // else arrives after it would have fired. A fake clock makes that window
            // virtual: advance far past the budget and prove the code list is frozen.
            const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
            try {
                const shutdown = createShutdown({ drain: async () => { throw new Error('store refused to close') }, timeoutMs: 50, exit: (c) => codes.push(c), log: silentLog })
                shutdown('SIGTERM')
                await clock.tickAsync(0)
                assert.deepStrictEqual(codes, [1])
                await clock.tickAsync(500)
                assert.deepStrictEqual(codes, [1], 'a cleared timer must not add a second exit')
            } finally { clock.restore() }
        })

        it('does not fire the hard-exit timer after a clean drain', async function(){
            const codes = []
            const clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
            try {
                const shutdown = createShutdown({ drain: async () => {}, timeoutMs: 20, exit: (c) => codes.push(c), log: silentLog })
                shutdown('SIGTERM')
                await clock.tickAsync(0)
                assert.deepStrictEqual(codes, [0])
                await clock.tickAsync(500)
                assert.deepStrictEqual(codes, [0], 'a cleared timer must not add a second exit')
            } finally { clock.restore() }
        })
    })

    describe('resolveTimeoutMs', function(){
        it('prefers an explicit budget, then the env var, then the default', function(){
            assert.strictEqual(resolveTimeoutMs(1234, {}), 1234)
            assert.strictEqual(resolveTimeoutMs(undefined, { SHUTDOWN_TIMEOUT_MS: '4321' }), 4321)
            assert.strictEqual(resolveTimeoutMs(undefined, {}), DEFAULT_SHUTDOWN_TIMEOUT_MS)
            assert.strictEqual(resolveTimeoutMs(0, { SHUTDOWN_TIMEOUT_MS: 'nonsense' }), DEFAULT_SHUTDOWN_TIMEOUT_MS)
        })

        it('stays under the 120 s budget xchain-node gives a tracker, and above docker\'s ten seconds', function(){
            assert.ok(DEFAULT_SHUTDOWN_TIMEOUT_MS < 120000)
            assert.ok(DEFAULT_SHUTDOWN_TIMEOUT_MS > 10000)
        })
    })

    describe('closeServer', function(){
        it('resolves once, and drops idle keep-alive sockets that would hold close() open', async function(){
            const server = makeServer([])
            await closeServer(server)
            assert.strictEqual(server.closed, true)
            assert.strictEqual(server.idleDropped, true)
        })

        it('resolves on a missing or closeless server rather than hanging the drain', async function(){
            await closeServer(null)
            await closeServer({})
        })
    })

    describe('closeStores', function(){
        it('closes each handle once and survives one that refuses', async function(){
            let closes = 0
            const ok = { async close(){ closes++ } }
            const bad = { async close(){ throw new Error('refused') } }
            await closeStores([ok, ok, bad, null, {}], silentLog)
            assert.strictEqual(closes, 1)
        })
    })

    describe('createTrackerDrain', function(){

        it('stops the tracker, drains the server and loop, then closes both stores', async function(){
            const order   = []
            const tracker = makeTracker(order)
            const server  = makeServer(order)
            const drain = createTrackerDrain({ tracker, server, loopSettled: tracker.loop, log: silentLog })
            await drain()

            assert.strictEqual(tracker.stopped, true)
            assert.strictEqual(server.closed, true)
            for (const name of ['db', 'mempoolDb']){
                assert.ok(order.indexOf('close:' + name) > order.indexOf('server.close'), name + ' must close after the server has drained')
                assert.ok(order.indexOf('close:' + name) > order.indexOf('stop'), name + ' must close after the block loop was told to stop')
            }
            assert.ok(tracker.db.closed && tracker.mempoolDb.closed)
        })

        it('waits for the block loop to break before closing stores', async function(){
            const order   = []
            const tracker = makeTracker(order)
            const server  = makeServer(order)
            let breakLoop
            const loop = new Promise((res) => { breakLoop = res })
            const drain = createTrackerDrain({ tracker, server, loopSettled: loop, log: silentLog })

            let settled = false
            const running = drain().then(() => { settled = true })
            await flushMacrotasks()
            assert.strictEqual(settled, false, 'the drain must not finish while the block loop is mid-batch')
            assert.strictEqual(tracker.db.closed, false, 'closing the store under an open batch is the abort this fix removes')

            breakLoop()
            await running
            assert.strictEqual(tracker.db.closed, true)
        })

        it('survives a rejected loop promise', async function(){
            const order   = []
            const tracker = makeTracker(order)
            const server  = makeServer(order)
            const drain = createTrackerDrain({ tracker, server, loopSettled: Promise.reject(new Error('fatal')), log: silentLog })
            await drain()
            assert.strictEqual(tracker.db.closed, true)
        })

        it('drains a partially-built process without throwing', async function(){
            const drain = createTrackerDrain({ tracker: null, server: null, log: silentLog })
            await drain()
        })
    })

    // The real stop(): it must only ASK. stopParsing() restores keepParsing when
    // the loop does not stop in ten seconds, which for a drain would mean the
    // process outlives its signal with the loop running again.
    describe('XChainUtxoTracker.stop()', function(){
        it('drops keepParsing and clears the mempool poller without waiting', function(){
            const tracker = Object.create(XChainUtxoTracker.prototype)
            tracker.keepParsing = true
            tracker.mempoolInterval = setInterval(() => {}, 60000)
            tracker.stop()
            assert.strictEqual(tracker.keepParsing, false)
            assert.strictEqual(tracker.mempoolInterval, null)
        })
    })

    // The whole file is moot if npm sits between docker and node.
    describe('Dockerfile', function(){
        it('runs node as PID 1 with the api script\'s heap flag, not npm', function(){
            const dockerfile = fs.readFileSync(path.join(__dirname, '../../Dockerfile'), 'utf8')
            const cmd = dockerfile.split('\n').filter(l => l.startsWith('CMD')).pop()
            assert.strictEqual(cmd, 'CMD ["node", "--max-old-space-size=4096", "./src/api.js"]')
            const pkg = require('../../package.json')
            assert.strictEqual(pkg.scripts.api, 'node --max-old-space-size=4096 ./src/api.js', 'the CMD mirrors the api script; change both together')
        })
    })
})
