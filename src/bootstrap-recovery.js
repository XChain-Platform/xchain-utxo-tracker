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

'use strict'

// Recovery handlers for the bootstrap snapshot / restore admin RPCs (M-9).
// Extracted from api.js so the fail-safe / fail-loud control flow is unit
// testable without booting the whole server (api.js self-invokes on require).

function recordFailure(tasks, taskId, error) {
    if (tasks && tasks[taskId]) {
        tasks[taskId].progress = -1
        tasks[taskId].error = String(error && error.message ? error.message : error)
    }
}

// Bootstrap (compression) failure leaves /data untouched, so resume indexing
// instead of freezing the tracker, and KEEP the task record (progress -1 plus
// the error) so a status poll surfaces the failure rather than a bare
// "taskid doesn't exist". `relaunch` restarts the polling loop.
function handleBootstrapFailure({ tasks, taskId, error, relaunch, log = console.error }) {
    recordFailure(tasks, taskId, error)
    log('Bootstrap compression failed; resuming indexing:', error)
    relaunch()
}

// Restore (decompression) wipes /data BEFORE extracting, so a mid-restore
// failure leaves the on-disk DB partially wiped and untrustworthy. Do NOT
// silently resume indexing on a corrupt store: record the failure and fail loud
// via `failLoud` so the supervisor restarts the process into a clean recovery
// path (empty /data -> bulk-sync, or an operator resync).
function handleRestoreFailure({ tasks, taskId, error, failLoud, log = console.error }) {
    recordFailure(tasks, taskId, error)
    log('[fatal] Bootstrap restore failed AFTER /data was wiped; the DB is now incomplete. Exiting for a supervised restart.', error)
    failLoud()
}

module.exports = { handleBootstrapFailure, handleRestoreFailure }
