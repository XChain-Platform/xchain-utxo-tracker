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

// The background job that rebuilds a newly watched address's past.
//
// Bitcoin Core keeps no address index (scantxoutset sees only the current UTXO
// set, and -txindex finds a transaction by id, not by address), so the past is
// rebuilt from the tracker's own block source: the blocks from the address's
// first-seen height up to the block before live ingest took it over, fetched in
// small batches and scanned with the address's open outputs (block_scan.js).
//
// Bounded: at most `concurrency` passes run at once, each over at most `passMax`
// addresses, a chunk of `chunkBlocks` blocks at a time with a pause after each.
// Resumable: each chunk commits the address's rows, and its progress (next
// height and open outputs) is checkpointed with them; a restart picks every
// unfinished address up from its last checkpoint. The progress record holds
// every open output, so writing it each chunk would make a deep address's
// writes grow as open outputs times chunks. It is stored only once the blocks
// scanned since the last checkpoint earn it (OPEN_PER_BLOCK outputs a block),
// which keeps the record bytes written per block bounded whatever the open set.
// A lagging checkpoint is safe: rows are absolute puts, so rescanning from an
// older (next, open) pair rewrites the same rows. The in-memory progress still
// moves every chunk, so a rollback and a pass retry see the true position. A chunk is written only for blocks this store
// has committed, re-checked inside the history write section, so a reorg can
// neither slip a stale block in nor strand rows the rollback did not see.

const { withStoreCommit } = require('../XChainUtxoTracker/store_commit_lock.js')
const { withHistoryWrite } = require('./write_lock.js')
const { scanBlock } = require('./block_scan.js')
const { fetchBlocksWithAuxPowFallback } = require('../chain/auxpow_block_fetch.js')
const { getLogger } = require('../observability')

const logger = getLogger()

// Open outputs each scanned block earns toward the next progress checkpoint.
// An address with up to this many outputs a block is checkpointed every chunk.
const OPEN_PER_BLOCK = 50

function stateFrom(hex, entry){
    return {
        hex, buf: entry.buf, latin: entry.buf.toString('latin1'), target: -1, epoch: entry.epoch,
        next: entry.progress.next, unsavedBlocks: 0,
        open: new Map((entry.progress.open || []).map(([outpoint, value]) => [outpoint, BigInt(value)])),
    }
}

function cloneState(s){
    return { ...s, open: new Map(s.open) }
}

function progressRecord(state, done){
    return done ? { next: state.next, done: true, open: [] }
        : { next: state.next, done: false, open: [...state.open].map(([o, v]) => [o, v.toString()]) }
}

class HistoryBackfill {
    constructor(tracker, watch, options){
        this.tracker = tracker
        this.watch = watch
        this.options = options
        this.pending = new Set()
        this.inFlight = new Set()
        this.passes = new Set()
        this.passesStarted = 0
        this.stopped = false
        this.wakers = new Set()
    }

    // Queues an address; false when it is already queued or being rebuilt.
    enqueue(hex){
        return this.enqueueMany([hex]) === 1
    }

    // Queues several addresses before any pass starts, so one request's batch is
    // rebuilt in one walk over the chain. Returns how many were newly queued.
    enqueueMany(hexes){
        if (this.stopped) return 0
        const fresh = hexes.filter((hex) => !this.pending.has(hex) && !this.inFlight.has(hex))
        for (const hex of fresh) this.pending.add(hex)
        this.kick()
        return fresh.length
    }

    kick(){
        while (!this.stopped && this.passes.size < this.options.concurrency && this.pending.size > 0) {
            const hexes = [...this.pending].slice(0, this.options.passMax)
            for (const hex of hexes) { this.pending.delete(hex); this.inFlight.add(hex) }
            this.passesStarted++
            const pass = this.runPass(hexes).finally(() => {
                this.passes.delete(pass)
                for (const hex of hexes) this.inFlight.delete(hex)
                this.kick()
            })
            this.passes.add(pass)
        }
    }

    // Ends every waiting pause early (a new liveFrom claim, or stop).
    wake(){
        for (const resolve of this.wakers) resolve()
        this.wakers.clear()
    }

    pause(ms){
        if (this.stopped) return Promise.resolve()
        return new Promise((resolve) => {
            const timer = setTimeout(() => { this.wakers.delete(resolve); resolve() }, ms)
            if (timer.unref) timer.unref()
            this.wakers.add(resolve)
        })
    }

    async stop(){
        this.stopped = true
        this.wake()
        await Promise.all([...this.passes])
    }

    // A pass that fails outside a chunk (the store read for the tip, a progress
    // write) logs and queues its addresses again after the retry pause.
    async runPass(hexes){
        try {
            await this.passLoop(hexes)
        } catch (err) {
            logger.warn('History backfill pass failed, retrying: ' + (err && err.message))
            if (this.running()) await this.pause(this.options.retryMs)
            if (this.running()) setImmediate(() => this.enqueueMany(hexes))
        }
    }

    // False once stopped, or once the loop that owns the store halted or aborted.
    running(){
        return !this.stopped && !this.tracker.halted && !this.tracker.parsingAborted
    }

    async passLoop(hexes){
        let states = hexes.map((hex) => stateFrom(hex, this.watch.get(hex)))
        while (this.running() && states.length > 0) {
            // A rollback below an address's scan restarts it (watch.resetAbove); take the restart up.
            states = states.map((s) => (s.epoch === this.watch.get(s.hex).epoch ? s : stateFrom(s.hex, this.watch.get(s.hex))))
            states = await this.settle(states, await this.tracker.db.getLastBlockHeight())
            const active = states.filter((s) => s.next <= s.target)
            if (states.length === 0) break
            if (active.length === 0) { await this.pause(this.options.waitMs); continue }
            const ok = await this.runChunk(active)
            await this.pause(ok ? this.options.pauseMs : this.options.retryMs)
        }
    }

    // Sets each state's target height and finishes the ones live ingest has caught
    // up with. Returns the states still to scan.
    async settle(states, tip){
        const left = []
        for (const state of states) {
            const { liveFrom, progress } = this.watch.get(state.hex)
            if (progress.unavailable) continue
            if (liveFrom !== null && state.next >= liveFrom) {
                await this.finish(state, progressRecord(state, true))
                continue
            }
            state.target = liveFrom === null ? tip : Math.min(liveFrom - 1, tip)
            left.push(state)
        }
        return left
    }

    async finish(state, record){
        await withStoreCommit(this.tracker, () => this.tracker.db.writeHistoryBackfill([], [{ script: state.buf, record }]))
        this.watch.get(state.hex).progress = record
    }

    // One chunk for the active states. True when it committed; false when a block
    // was not (or no longer) committed here, or the node or store failed, so the
    // pass pauses and tries the same chunk again.
    async runChunk(active){
        const from = Math.min(...active.map((s) => s.next))
        const to = Math.min(from + this.options.chunkBlocks - 1, Math.max(...active.map((s) => s.target)))
        const heights = []
        for (let h = from; h <= to; h++) heights.push(h)
        try {
            const fetched = await this.fetchBlocks(heights)
            const work = active.map(cloneState)
            const scanned = []
            const rows = []
            // One block's decode and scan at a time, yielding between blocks so a
            // chunk never holds the event loop for more than one block's work.
            for (let i = 0; i < fetched.length; i++) {
                const block = this.tracker.xchainBlockDecoder.blockFromHex(fetched[i].hex)
                scanned.push({ hash: fetched[i].hash, height: heights[i] })
                for (const row of scanBlock(block, heights[i], work)) rows.push({ ...row, hash: fetched[i].hash, height: heights[i], time: block.timestamp })
                await new Promise((resolve) => setImmediate(resolve))
            }
            if (!(await this.commitChunk(scanned, rows, work))) return false
            work.forEach((w, i) => Object.assign(active[i], w))
            return true
        } catch (err) {
            logger.warn('History backfill chunk ' + from + '-' + to + ' failed, retrying: ' + (err && err.message))
            return false
        }
    }

    fetchBlocks(heights){
        return fetchBlocksWithAuxPowFallback(
            this.tracker.connector,
            heights,
            this.tracker.auxPow,
            (message) => logger.warn('History backfill: ' + message)
        )
    }

    // Writes the chunk if every block in it is still the one this store committed
    // at its height. An address whose open outputs outgrow the ceiling is marked
    // unavailable instead: its past is too large to rebuild this way.
    async commitChunk(scanned, rows, work){
        return withHistoryWrite(this.tracker, async () => {
            // A rollback restarted one of these addresses after the chunk was scanned.
            if (work.some((w) => w.epoch !== this.watch.get(w.hex).epoch)) return false
            const checks = await this.tracker.db.getBackfillBlockChecks(scanned.map((b) => b.hash))
            if (checks.some((c, i) => c.height !== scanned[i].height)) return false
            const inWindow = new Map(scanned.map((b, i) => [b.hash, checks[i].inWindow]))
            const progress = work.map((w) => this.chunkProgress(w, scanned.length))
            const writes = rows.filter((r) => r.state.open.size <= this.options.openMax).map((r) => ({
                script: r.state.buf, height: r.height, txid: r.txid, received: r.received, sent: r.sent,
                time: r.time, blockHash: r.hash, indexed: inWindow.get(r.hash) }))
            const due = progress.filter((p) => p.save).map(({ script, record }) => ({ script, record }))
            await withStoreCommit(this.tracker, () => this.tracker.db.writeHistoryBackfill(writes, due))
            for (const { script, record } of progress) this.watch.get(script.toString('hex')).progress = record
            return true
        })
    }

    // One address's progress after a chunk of `blocks` blocks, and whether it is
    // stored now. Unavailable is stored at once; a state with no checkpoint
    // counter (built outside stateFrom) is stored every chunk.
    chunkProgress(w, blocks){
        if (w.open.size > this.options.openMax) {
            return { script: w.buf, save: true, record: { next: w.next, done: false, unavailable: true, open: [] } }
        }
        const perBlock = this.options.checkpointOpenPerBlock ?? OPEN_PER_BLOCK
        const unsaved = (w.unsavedBlocks ?? Infinity) + blocks
        const save = w.open.size <= unsaved * perBlock
        w.unsavedBlocks = save ? 0 : unsaved
        return { script: w.buf, save, record: progressRecord(w, false) }
    }
}

module.exports = HistoryBackfill
