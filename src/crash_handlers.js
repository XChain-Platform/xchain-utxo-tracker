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
 * XChain UTXO Tracker - process crash visibility
 *
 * The tracker has neither an uncaughtException nor an unhandledRejection
 * handler, so a throw outside the polling promise kills the process with node's
 * default stderr dump: no timestamp, no level, no service tag, nothing a
 * collector can key on. What an operator sees is a container that restarted,
 * which for this service is the shape of the crash loop that ran 5000+ times
 * before the unrecoverable-reorg halt landed.
 *
 * noteCrash covers the two paths that end the process on their own: the polling
 * loop's rejection handler and the bulk-sync boot chain. Both take the same
 * record shape as the handlers, so one event covers every way this service dies.
 *
 * Emission is through the shim's getLogger() rather than console because a
 * patched console line cannot carry structured fields, and the fields are the
 * point.
 *
 * Handlers are installed from the entry-point guard in api.js, never at module
 * scope: many suites require api.js in-process under mocha, which installs its
 * own handlers, and a module-scope handler that exits would abort the whole run
 * instead of failing one test.
 *
 ********************************************************************/

'use strict'

const { getLogger, getRegistry } = require('./observability')

let _counters = null

function counters() {
  if (!_counters) {
    const registry = getRegistry()
    _counters = {
      crashes: registry.counter({
        name: 'xchain_crashes_total',
        help: 'Uncaught exceptions and unhandled rejections',
        labelNames: ['kind']
      })
    }
  }
  return _counters
}

// One CRASH record, whatever ended the process. `kind` names which of the three
// paths it came from so a reader can tell a loop that died from a stray throw.
function noteCrash(kind, err) {
  try { counters().crashes.inc({ kind }, 1) } catch { /* never mask the crash */ }
  try {
    return getLogger().error('CRASH', {
      kind,
      err: err && err.message ? err.message : String(err),
      stack: err && err.stack ? err.stack : undefined
    })
  } catch { return null }
}

/**
 * @param {object} [opts]
 * @param {object} [opts.proc]               process-like target, for tests
 * @param {boolean} [opts.exitOnUncaught=true]
 */
function installCrashHandlers({ proc = process, exitOnUncaught = true } = {}) {
  proc.on('uncaughtException', (err) => {
    noteCrash('uncaughtException', err)
    // Process state after an uncaught throw is unknown: the tracker may hold an
    // open LevelDB batch and a half-written block, so it exits for a supervised
    // restart rather than carrying that state into the next poll.
    if (exitOnUncaught) proc.exit(1)
  })

  proc.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason))
    noteCrash('unhandledRejection', err)
  })
}

// Tests only: the counter handles are process-wide.
function _resetCrashCounters() {
  _counters = null
}

module.exports = { installCrashHandlers, noteCrash, _resetCrashCounters }
