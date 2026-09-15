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
 * XChain UTXO Tracker - UTXO Tracker Class
 *
 ********************************************************************/

const { logger } = require('./constants.js')

module.exports = {
    // The halted state itself, shared by the live halt and the boot-time resume
    // from a persisted marker so the two cannot drift apart.
    enterHaltedState({ reason, at, height }){
        this.halted = true
        this.haltReason = reason
        this.haltedAt = at
        this.haltedHeight = height
        // The loop is gone (it threw, or was never started) and skipped the
        // normal-stop branch that sets parsingStopped. Record that: without it
        // stopParsing() can only time out, and both recovery RPCs open with that
        // wait, so the resync this halt exists to enable is unreachable on the one
        // state that needs it.
        this.parsingAborted = true
        this.parsingStopped = false
        if (this.mempoolInterval){ clearInterval(this.mempoolInterval); this.mempoolInterval = null }
    },

    // Write the R marker so the NEXT process boots straight into the halted state
    // (resumeHaltFromMarker) instead of rediscovering the fault by rolling back
    // into a window that is already drained. Stamps the committed height the halt
    // was declared at. Fail-soft: a store that cannot take the write (closed, or a
    // test stub) leaves the in-memory halt in force and says so once.
    async persistHaltMarker(){
        const store = this.db
        if (!store || typeof store.setHaltMarker !== 'function') return null
        try {
            if (this.haltedHeight === null) this.haltedHeight = await store.getLastBlockHeight()
            return await store.setHaltMarker({ reason: this.haltReason, height: this.haltedHeight, at: this.haltedAt })
        } catch (err) {
            logger.warn('[halted] could not persist the halt marker (' + (err && err.message)
                + '); the halt holds for this process, but a restart will rediscover it by rolling back')
            return null
        }
    },

    // Boot-time half of the marker: read it before the sync loop starts and, when
    // present, take the halted state without a rollback attempt or a throw. The
    // stored tip is the one already declared unrecoverable, so any attempt would
    // meet the same drained window, and a boot that halts silently only after that
    // reads as a fresh fault to a monitor watching the log. Returns true when the
    // caller (start) must stop here.
    async resumeHaltFromMarker(){
        let marker = null
        try {
            marker = await this.db.getHaltMarker()
        } catch (_) {
            // A store that cannot answer for the one diagnostic key boots as usual.
        }
        if (!marker) return false
        this.enterHaltedState({ reason: marker.reason, at: marker.at, height: marker.height })
        logger.error('[halted] marker from ' + (marker.at || 'unknown time') + ' at height '
            + (marker.height === null ? 'unknown' : marker.height) + ': ' + marker.reason)
        return true
    },

    // Drop the R marker from whichever store is open. Fail-soft for the same
    // reason the write is: on the restore path the old store is already closed
    // and wiped, so there is nothing to delete and the replacement store carries
    // its own answer when start() reads it.
    async deleteHaltMarker(){
        const store = this.db
        if (!store || typeof store.deleteHaltMarker !== 'function') return false
        try {
            await store.deleteHaltMarker()
            return true
        } catch (_) {
            return false
        }
    }
}
