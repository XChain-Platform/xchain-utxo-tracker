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

// The SIGTERM drain must wait for the block loop that is running NOW. The
// getbootstrap and restorebootstrap admin RPCs stop the first loop and start a new
// one, dropping the promise; a drain holding only the first promise would close the
// live store under the relaunched loop and let the process report a clean stop.

const assert = require('assert')
const { createTrackerDrain } = require('../../../src/server/shutdown')
const { createLoopRecorder } = require('../../../src/api/startup')

const silentLog = { log(){}, warn(){}, error(){} }
const flush = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)) }

function deferred(){
    let resolve
    const promise = new Promise((res) => { resolve = res })
    return { promise, resolve }
}

function makeTracker(){
    const store = () => ({ closed: false, async close(){ this.closed = true } })
    return { stopped: false, db: store(), mempoolDb: store(), stop(){ this.stopped = true } }
}

const idleServer = { close(cb){ setImmediate(cb) }, closeIdleConnections(){} }

describe('shutdown drain after an in-process relaunch', function(){

    it('keeps the stores open until the relaunched loop settles', async function(){
        const first = deferred()
        const second = deferred()
        const loops = [first, second]
        const tracker = makeTracker()
        const recorder = createLoopRecorder(() => loops.shift().promise)
        recorder.launch(tracker)
        first.resolve()
        await flush()
        recorder.launch(tracker)

        const drain = createTrackerDrain({ tracker, server: idleServer, loopSettled: () => recorder.current, log: silentLog })
        let done = false
        const running = drain().then(() => { done = true })
        await flush()
        assert.strictEqual(done, false, 'the first loop is long settled, the second is still mid-batch')
        assert.strictEqual(tracker.db.closed, false)

        second.resolve()
        await running
        assert.strictEqual(tracker.db.closed, true)
        assert.strictEqual(tracker.mempoolDb.closed, true)
    })

    it('also waits for a loop launched while an earlier one was being awaited', async function(){
        const first = deferred()
        const second = deferred()
        let current = first.promise
        const tracker = makeTracker()
        const drain = createTrackerDrain({ tracker, server: idleServer, loopSettled: () => current, log: silentLog })
        let done = false
        const running = drain().then(() => { done = true })
        await flush()
        current = second.promise
        first.resolve()
        await flush()
        assert.strictEqual(done, false)
        assert.strictEqual(tracker.db.closed, false)
        second.resolve()
        await running
        assert.strictEqual(tracker.db.closed, true)
    })

    it('still accepts a fixed loop promise', async function(){
        const tracker = makeTracker()
        const drain = createTrackerDrain({ tracker, server: idleServer, loopSettled: Promise.reject(new Error('fatal')), log: silentLog })
        await drain()
        assert.strictEqual(tracker.db.closed, true)
    })

    it('records the promise of every launch and returns it to the caller', function(){
        const tracker = makeTracker()
        const promises = [Promise.resolve('a'), Promise.resolve('b')]
        const recorder = createLoopRecorder(() => promises.shift())
        const a = recorder.launch(tracker)
        assert.strictEqual(recorder.current, a)
        const b = recorder.launch(tracker)
        assert.strictEqual(recorder.current, b)
        assert.notStrictEqual(a, b)
    })

    it('refuses a relaunch once shutdown has begun', async function(){
        let launches = 0
        const recorder = createLoopRecorder(() => { launches++; return Promise.resolve() })
        recorder.launch(makeTracker())
        recorder.closing = true
        await recorder.launch(makeTracker())
        assert.strictEqual(launches, 1)
    })

    it('leaves an absent launcher absent', function(){
        assert.strictEqual(createLoopRecorder(undefined).launch, undefined)
    })
})
