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

// The in-memory twin of the store's history watch list (U records).
//
// Two heights describe one watched address. `start` is the first block that can
// hold its history: its first-seen height, or the block after the committed tip
// when it was added if the tracker had never seen it. `liveFrom` is the first
// block the sync loop staged with the address in its watch snapshot; from there
// live ingest writes its rows, and the backfill job owns [start, liveFrom - 1].
//
// `scripts` is the set the sync loop snapshots once per block. It is replaced,
// never mutated, when an address joins, so a block staged against one snapshot
// sees the same membership from its first output to its last spend.

class HistoryWatchList {
    constructor({ max }){
        this.max = max
        this.entries = new Map()
        this.scripts = new Set()
        this.unclaimed = new Set()
    }

    // Takes up the records read from the store at start.
    load(records){
        for (const [hex, rec] of records) {
            if (rec.start === null || rec.progress === null) continue
            this.entries.set(hex, { buf: Buffer.from(hex, 'hex'), start: rec.start, liveFrom: rec.liveFrom, progress: rec.progress, epoch: 0 })
            if (rec.liveFrom === null) this.unclaimed.add(hex)
        }
        this.scripts = new Set([...this.entries.values()].map((e) => e.buf.toString('latin1')))
        return this
    }

    get size(){ return this.entries.size }
    get unclaimedCount(){ return this.unclaimed.size }
    get(hex){ return this.entries.get(hex) }
    has(hex){ return this.entries.has(hex) }
    isFull(extra = 0){ return this.entries.size + extra >= this.max }

    // Joins an address. It enters the ingest snapshot at once; its start and
    // progress follow from the caller's store reads (setStart).
    add(hex, buf){
        this.entries.set(hex, { buf, start: null, liveFrom: null, progress: null, epoch: 0 })
        this.unclaimed.add(hex)
        this.scripts = new Set(this.scripts).add(buf.toString('latin1'))
    }

    setStart(hex, start, progress){
        const entry = this.entries.get(hex)
        entry.start = start
        entry.progress = progress
    }

    // Records `height` as liveFrom for every address not yet claimed, and returns
    // those addresses so the caller can persist the height. The caller passes the
    // height of the block it is about to stage, or the next height while no batch
    // is open, so every block at or above it is staged with these addresses.
    claimLiveFrom(height){
        const claimed = []
        for (const hex of this.unclaimed) {
            const entry = this.entries.get(hex)
            entry.liveFrom = height
            claimed.push(entry)
        }
        this.unclaimed.clear()
        return claimed
    }

    // What the history route reports for one address: its backfill state and the
    // lowest height from which its rows are complete.
    status(hex){
        const entry = this.entries.get(hex)
        if (!entry) return null
        if (entry.progress && entry.progress.unavailable) {
            return { history_status: 'unavailable', history_from_height: entry.liveFrom }
        }
        if (isComplete(entry)) return { history_status: 'complete', history_from_height: entry.start }
        return { history_status: 'backfilling', history_from_height: entry.liveFrom }
    }

    // A rollback of the block at `height` orphans what any unfinished backfill
    // scanned at or above it: its open outputs and its next height describe a chain
    // that is gone. Restarts each such address from min(start, height) with no open
    // outputs (the new chain may pay it below its old first-seen height) and bumps
    // its epoch so a running pass drops its copy. Returns the restarted entries.
    resetAbove(height){
        const restarted = []
        for (const entry of this.entries.values()) {
            const p = entry.progress
            if (!p || p.done || p.unavailable || p.next <= height) continue
            entry.start = Math.min(entry.start, height)
            entry.progress = { next: entry.start, done: false, open: [] }
            entry.epoch++
            restarted.push(entry)
        }
        return restarted
    }

    // Addresses whose past still has to be rebuilt.
    incomplete(){
        return [...this.entries].filter(([, e]) => e.progress && !e.progress.done && !e.progress.unavailable).map(([hex]) => hex)
    }
}

// Complete once the backfill has reached the block live ingest took the address
// over from, even before the runner writes its done flag: a never-seen address
// joining at the tip is complete as soon as its liveFrom is claimed.
function isComplete(entry){
    const p = entry.progress
    if (!p) return false
    return p.done || (entry.liveFrom !== null && p.next >= entry.liveFrom)
}

module.exports = HistoryWatchList
