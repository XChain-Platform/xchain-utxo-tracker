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

const { EventEmitter } = require('events')

const crash = require('../../src/server/crash_handlers.js')
const observability = require('../../src/observability')
const {
  registerSignalTests, registerCrashRecordTests
} = require('../helpers/crash_handler_registration.js')

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
    crash.resetCrashCounters()
    sink = { lines: [] }
    const push = (m) => sink.lines.push(m)
    observability.installObservability(null, {
      service: 'xchain-utxo-tracker', env: {}, console: { log: push, warn: push, error: push }
    })
  })

  afterEach(function () {
    observability._resetObservability()
    crash.resetCrashCounters()
  })

  const helpers = { crash, observability, lines, crashCount, fakeProc }
  registerSignalTests(helpers)
  registerCrashRecordTests(helpers)
})
