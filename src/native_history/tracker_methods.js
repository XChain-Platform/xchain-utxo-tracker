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
 * XChain UTXO Tracker - confirmed native coin history for watched addresses
 *
 ********************************************************************/

const { createHash } = require('crypto')
const config = require('../config')
const { addressToScript } = require('../XChainUtxoTracker/address_script.js')
const { withStoreRead } = require('../XChainUtxoTracker/store_commit_lock.js')
const HistoryWatchList = require('./watch_list.js')
const HistoryAdmission = require('./admission.js')
const HistoryBackfill = require('./backfill.js')

// The feature's limits and pacing. The caps come from config; a test may override
// any of them through tracker.historyOptions before init.
function historyDefaults(){
    return {
        watchMax: config.HISTORY_WATCH_MAX,
        concurrency: config.HISTORY_BACKFILL_CONCURRENCY,
        perIp: config.HISTORY_NEW_PER_IP,
        windowMs: 60 * 60 * 1000,
        cooldownMs: config.HISTORY_COOLDOWN_SECONDS * 1000,
        // A pass rebuilds up to a full request's addresses together, so a wallet's
        // twenty first requests cost one walk over the chain, not twenty.
        passMax: 20,
        chunkBlocks: 10,
        pauseMs: 20,
        waitMs: 1000,
        retryMs: 5000,
        // Open outputs one address may hold while rebuilt; past it the address is unavailable.
        openMax: 100000,
        now: Date.now,
    }
}

function notReady(){
    return Object.assign(new Error('native history is not ready: the tracker has not indexed a block yet'), { code: 'NOT_READY' })
}

module.exports = {
    // Loads the watch list and resumes every unfinished backfill. Run by start()
    // once the store is open; a restore re-runs start() and so this.
    async initNativeHistory(){
        if (this.historyBackfill) await this.historyBackfill.stop()
        const options = { ...historyDefaults(), ...(this.historyOptions || {}) }
        this.historyReserving = new Set()
        this.historyWatch = new HistoryWatchList({ max: options.watchMax }).load(await this.db.getHistoryWatchRecords())
        this.historyAdmission = new HistoryAdmission(options)
        this.historyBackfill = new HistoryBackfill(this, this.historyWatch, options)
        this.historyBackfill.enqueueMany(this.historyWatch.incomplete())
    },

    // Run inside a block rollback's open batch and history write section: restarts
    // every unfinished backfill that scanned the rolled-back block (watch.resetAbove)
    // and stages their restart with the rollback, so both commit or neither does.
    async resetHistoryBackfillsAbove(height){
        if (!this.historyWatch) return
        const restarted = this.historyWatch.resetAbove(height)
        for (const entry of restarted) await this.db.stageHistoryRestart(entry.buf, entry.start, entry.progress)
        if (restarted.length > 0) this.historyBackfill.wake()
    },

    // The backfill writes to the store, so the sync loop stops it before the store closes.
    async stopNativeHistory(){
        if (this.historyBackfill) await this.historyBackfill.stop()
    },

    // Gives every newly watched address its liveFrom height, persisted into the
    // open batch (staged) or straight away (no batch open), and returns the watch
    // snapshot the block about to be staged must use.
    async claimHistoryLiveFrom(height, { staged }){
        const claimed = this.historyWatch.claimLiveFrom(height)
        for (const entry of claimed) await this.db.setHistoryLiveFrom(entry.buf, height, { staged })
        if (claimed.length > 0) this.historyBackfill.wake()
        return this.historyWatch.scripts
    },

    // One page of confirmed history for up to a batch of addresses, newest first,
    // plus each address's backfill state. An address seen here for the first time
    // joins the watch list (if admitted) and gets a backfill job; the page answers
    // with what is already known.
    async getNativeHistory(addresses, opts, { ip } = {}){
        if (!this.historyWatch) throw notReady()
        const plan = historyScriptPlan(addresses, this.network)
        const refused = await admitNewAddresses.call(this, plan, ip)
        const read = await withStoreRead(this, () => readNativeHistory.call(this, plan, opts))
        read.addressStatus = addressStatus.call(this, plan, refused)
        return read
    }
}

// Each distinct script hash with the requested addresses that pay to it (an LTC
// test-network 0x3a P2SH address and its 0xc4 twin share one). A malformed
// address refuses the whole request, as the explorer's batch routes do.
function historyScriptPlan(addresses, network){
    const byScript = new Map()
    for (const address of addresses){
        let script
        try { script = addressToScript(address, network) }
        catch (err) {
            throw Object.assign(new Error('Invalid address: ' + String(address).slice(0, 128)), { code: 'INVALID_ADDRESS' })
        }
        const buf = createHash('sha256').update(script).digest()
        const hex = buf.toString('hex')
        if (!byScript.has(hex)) byScript.set(hex, { buf, hex, addresses: [] })
        byScript.get(hex).addresses.push(address)
    }
    return [...byScript.values()]
}

// Admits the plan's unwatched addresses and starts their backfills. Returns the
// refusals by script hex. The store reads are one getMany and one get, and the
// write one batch, whatever the number of new addresses.
async function admitNewAddresses(plan, ip){
    const watch = this.historyWatch
    const refused = new Map()
    const admitted = []
    for (const entry of plan) {
        if (watch.has(entry.hex) || this.historyReserving.has(entry.hex)) continue
        const why = this.historyAdmission.admit(entry.hex, ip, watch.isFull(admitted.length))
        if (why) refused.set(entry.hex, why)
        else { admitted.push(entry); this.historyReserving.add(entry.hex) }
    }
    if (admitted.length === 0) return refused
    try {
        // Read before the addresses join the ingest snapshot: a block committed
        // after this tip may have been staged without them, and a start no higher
        // than tip + 1 keeps it inside the backfill's range.
        const tip = await this.db.getLastBlockHeight()
        if (tip < 0) throw notReady()
        const firstSeen = await this.db.getFirstSeenHeights(admitted.map((e) => e.buf))
        const adds = admitted.map((e, i) => {
            const start = firstSeen[i] === null ? tip + 1 : firstSeen[i]
            return { entry: e, script: e.buf, start, progress: { next: start, done: false, open: [] } }
        })
        for (const add of adds) watch.add(add.entry.hex, add.script)
        await this.db.addHistoryWatches(adds)
        for (const add of adds) watch.setStart(add.entry.hex, add.start, add.progress)
        this.historyBackfill.enqueueMany(adds.map((add) => add.entry.hex))
    } finally {
        for (const e of admitted) this.historyReserving.delete(e.hex)
    }
    return refused
}

// The per-address block of the answer: backfill state, or why it is not watched.
function addressStatus(plan, refused){
    const out = {}
    for (const entry of plan) {
        const status = refused.has(entry.hex)
            ? { history_status: 'not_watched', history_from_height: null, history_refused: refused.get(entry.hex) }
            : (this.historyWatch.status(entry.hex) || { history_status: 'backfilling', history_from_height: null })
        for (const address of entry.addresses) out[address] = status
    }
    return out
}

// Page order: newest block first, then txid ascending within a block (the A key order).
// Negative when position a comes before position b.
function comparePosition(a, b){
    if (a.height !== b.height) return b.height - a.height
    return a.txid < b.txid ? -1 : (a.txid > b.txid ? 1 : 0)
}

// Where the page ends. Each address that stopped short says how far down it has
// read everything; the page keeps only what EVERY address has read, so it ends
// at the earliest of those stop points. Cutting there means no transaction on
// the page is missing an address's share of it, and the next page starts just
// below it for every address. Null when every address was read to the end.
function pageCut(reads){
    let cut = null
    for (const read of reads){
        if (read.stoppedAt && (cut === null || comparePosition(read.stoppedAt, cut) < 0)) cut = read.stoppedAt
    }
    return cut
}

// The page's transactions, each one's per-address amounts, and its total across
// the distinct scripts (a script two requested addresses share counts once).
function mergeRows(plan, reads, cut){
    const byTx = new Map()
    plan.forEach((entry, i) => {
        for (const row of reads[i].rows){
            if (cut && comparePosition(row, cut) > 0) continue
            const txKey = row.height + ':' + row.txid
            if (!byTx.has(txKey)) byTx.set(txKey, { txid: row.txid, height: row.height, time: row.time, net: 0n, addresses: {} })
            const tx = byTx.get(txKey)
            const net = row.received - row.sent
            tx.net += net
            for (const address of entry.addresses){
                tx.addresses[address] = { received: row.received.toString(), sent: row.sent.toString(), net: net.toString() }
            }
        }
    })
    return [...byTx.values()]
        .sort(comparePosition)
        .map((tx) => ({ ...tx, net: tx.net.toString() }))
}

async function readNativeHistory(plan, opts){
    // The tip, its hash and the reorg count, read with the rows they label.
    const committedHeight = await this.db.getLastBlockHeight()
    const committedHash = await this.db.getLastBlockHash()
    const reorgCount = this.reorgCount
    const reads = await this.db.getHistoryRows(plan.map((entry) => entry.buf), opts)
    const cut = pageCut(reads)
    return {
        transactions: mergeRows(plan, reads, cut),
        cursor: cut ? cut.height + ':' + cut.txid : null,
        committedHeight,
        committedHash,
        reorgCount,
        mempoolEpoch: this.mempoolEpoch,
        mempoolReconverged: this.mempoolReconverged === true
    }
}
