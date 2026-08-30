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

// Row 4 of the proactive-system-watch spec: the tracker's crash records.
//
// The handlers run against a stand-in process so the real handler bodies
// execute without mocha's own handlers or a live process.exit taking part.

const assert = require('assert')
const { EventEmitter } = require('events')
const fs = require('fs')
const path = require('path')

const crash = require('../../src/crashHandlers.js')
const observability = require('../../src/observability')

describe('utxo-tracker crash handlers', function () {
  let sink

  function lines () { return sink.lines.filter(l => l.includes('CRASH')) }

  function crashCount (kind) {
    const line = observability.getRegistry().render().split('\n')
      .find(l => l.startsWith(`xchain_crashes_total{kind="${kind}"}`))
    return line ? Number(line.trim().split(' ').pop()) : 0
  }

  function fakeProc () {
    const proc = new EventEmitter()
    proc.exits = []
    proc.exit = (code) => proc.exits.push(code)
    return proc
  }

  beforeEach(function () {
    observability._resetObservability()
    crash._resetCrashCounters()
    sink = { lines: [] }
    const push = (m) => sink.lines.push(m)
    observability.installObservability(null, {
      service: 'xchain-utxo-tracker', env: {}, console: { log: push, warn: push, error: push }
    })
  })

  afterEach(function () {
    observability._resetObservability()
    crash._resetCrashCounters()
  })

  it('an uncaught exception emits one CRASH record and exits non-zero', function () {
    const proc = fakeProc()
    crash.installCrashHandlers({ proc })

    proc.emit('uncaughtException', new Error('probe-uncaught-tracker'))

    assert.strictEqual(lines().length, 1)
    assert.ok(lines()[0].includes('kind=uncaughtException'), lines()[0])
    assert.ok(lines()[0].includes('probe-uncaught-tracker'), lines()[0])
    assert.ok(lines()[0].includes('[xchain-utxo-tracker]'), lines()[0])
    assert.deepStrictEqual(proc.exits, [1])
    assert.strictEqual(crashCount('uncaughtException'), 1)
  })

  it('an unhandled rejection emits CRASH and lets the process continue', function () {
    const proc = fakeProc()
    crash.installCrashHandlers({ proc })

    proc.emit('unhandledRejection', new Error('probe-rejection-tracker'))

    assert.strictEqual(lines().length, 1)
    assert.ok(lines()[0].includes('kind=unhandledRejection'), lines()[0])
    assert.deepStrictEqual(proc.exits, [], 'a stray promise does not by itself corrupt shared state')
    assert.strictEqual(crashCount('unhandledRejection'), 1)
  })

  it('a non-Error rejection reason still yields a readable record', function () {
    const proc = fakeProc()
    crash.installCrashHandlers({ proc })
    proc.emit('unhandledRejection', 'plain string reason')
    assert.ok(lines()[0].includes('plain string reason'), lines()[0])
  })

  it('a broken logger cannot swallow the exit', function () {
    const proc = fakeProc()
    crash.installCrashHandlers({ proc })
    observability._resetObservability()
    proc.emit('uncaughtException', new Error('probe-no-sink'))
    assert.deepStrictEqual(proc.exits, [1])
  })

  // The polling loop and the bulk-sync boot end the process on their own, so
  // they take the same record shape rather than a bare stderr line.
  it('a terminated polling loop takes the CRASH shape, with its own kind', function () {
    crash.noteCrash('pollingLoopTerminated', new Error('node RPC gone'))

    assert.strictEqual(lines().length, 1)
    assert.ok(lines()[0].includes('kind=pollingLoopTerminated'), lines()[0])
    assert.ok(lines()[0].includes('node RPC gone'), lines()[0])
    assert.ok(lines()[0].includes('stack='), lines()[0])
    assert.strictEqual(crashCount('pollingLoopTerminated'), 1)
  })

  // The handlers are worth nothing unless the entry point installs them, and
  // requiring api.js here boots bulk-sync, so the wiring is read off the file.
  it('api.js installs them from the entry-point guard and uses noteCrash on both exit paths', function () {
    const src = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8')
    const guard = src.indexOf('require.main === module')
    const install = src.indexOf('installCrashHandlers()')
    assert.ok(guard > 0, 'entry-point guard present')
    assert.ok(install > guard, 'installCrashHandlers() is called inside the entry-point guard')
    assert.ok(src.includes("noteCrash('pollingLoopTerminated'"), 'the polling loop records a CRASH')
    assert.ok(src.includes("noteCrash('bootFailed'"), 'the boot chain records a CRASH')
  })
})
