'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const assert = require('assert')
const { EventEmitter } = require('events')
const fs = require('fs')
const path = require('path')
const { createBulkBoot, defaultSignalChild } = require('../../src/api/bulk_boot')
const { createShutdown, registerShutdownSignals } = require('../../src/server/shutdown')

const API_SRC = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8')
const silentLog = { log(){}, warn(){}, error(){} }

function child(pid = 4242){
    const proc = new EventEmitter()
    proc.pid = pid
    return proc
}

async function flush(){
    await new Promise((resolve) => setImmediate(resolve))
}

describe('bulk-sync boot stop drain', function(){
    it('signals the detached process group, not only its leader', function(){
        if (process.platform === 'win32') this.skip()
        const originalKill = process.kill
        const calls = []
        process.kill = (pid, signal) => calls.push([pid, signal])
        try {
            defaultSignalChild(child(4242), 'SIGTERM')
        } finally {
            process.kill = originalKill
        }
        assert.deepStrictEqual(calls, [[-4242, 'SIGTERM']])
    })

    it('signals the child tree, waits for its exit, then removes the partial target', async function(){
        const order = []
        const proc = child()
        const boot = createBulkBoot({
            dbPath: '/data/xchain-utxo-tracker',
            signalChild(target, signal){
                assert.strictEqual(target, proc)
                order.push('signal:' + signal)
            },
            removeDb(){ order.push('remove-db') },
            log: silentLog
        })
        const running = boot.trackChild(proc, (code, signal) =>
            new Error(signal || String(code))).catch(() => {})

        let drained = false
        const stopping = boot.stop().then(() => { drained = true })
        await flush()
        assert.deepStrictEqual(order, ['signal:SIGTERM'])
        assert.strictEqual(drained, false, 'the target must not be removed while its writer is alive')

        order.push('child-exit')
        proc.emit('exit', null, 'SIGTERM')
        await Promise.all([running, stopping])
        assert.deepStrictEqual(order, ['signal:SIGTERM', 'child-exit', 'remove-db'])
    })

    it('keeps a completed target and makes repeated stop calls idempotent', async function(){
        let signals = 0
        let removals = 0
        const proc = child()
        const boot = createBulkBoot({
            dbPath: '/data/xchain-utxo-tracker',
            signalChild(){ signals++ },
            removeDb(){ removals++ },
            log: silentLog
        })
        const running = boot.trackChild(proc)
        proc.emit('exit', 0, null)
        await running

        await Promise.all([boot.stop(), boot.stop()])
        assert.strictEqual(signals, 0)
        assert.strictEqual(removals, 0)
    })

    it('wakes the node-sync poll delay immediately when stop starts', async function(){
        const boot = createBulkBoot({
            dbPath: '/data/xchain-utxo-tracker',
            removeDb(){},
            log: silentLog
        })
        const delayed = boot.delay(60000)
        await boot.stop()
        assert.strictEqual(await delayed, false)
        assert.strictEqual(await boot.delay(60000), false)
    })

    it('reports a failed interrupted-target cleanup as an unclean shutdown', async function(){
        const proc = child()
        const exits = []
        const boot = createBulkBoot({
            dbPath: '/data/xchain-utxo-tracker',
            signalChild(){ setImmediate(() => proc.emit('exit', null, 'SIGTERM')) },
            removeDb(){ throw new Error('permission denied') },
            log: silentLog
        })
        boot.trackChild(proc).catch(() => {})
        const shutdown = createShutdown({
            drain: () => boot.stop(),
            timeoutMs: 1000,
            exit: (code) => exits.push(code),
            log: silentLog
        })
        shutdown('SIGTERM')
        await flush()
        await flush()
        assert.deepStrictEqual(exits, [1])
    })

    it('installs removable boot signal listeners before the API handoff', function(){
        const proc = new EventEmitter()
        const seen = []
        const remove = registerShutdownSignals((signal) => seen.push(signal), proc)
        proc.emit('SIGTERM')
        proc.emit('SIGINT')
        remove()
        proc.emit('SIGTERM')
        assert.deepStrictEqual(seen, ['SIGTERM', 'SIGINT'])
    })

    it('spawns the orchestrator as a process group and wires the early drain', function(){
        assert.match(API_SRC, /detached:\s*process\.platform !== 'win32'/)
        assert.match(API_SRC, /createBulkBoot\(\{ dbPath: DB_PATH \}\)/)
        assert.match(API_SRC, /registerShutdownSignals\(bootShutdown\)/)
        assert.match(API_SRC, /runBulkSyncIfEmpty\(bulkBoot\)/)
    })
})
