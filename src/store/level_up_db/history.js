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

// Native coin history for WATCHED addresses only (A rows), their per-block
// reverse index (V) and the watch list itself (U). An address joins the watch
// list on its first history request; from then the sync loop writes its rows
// for new blocks and a backfill job writes them for its past. No row is ever
// written for an address nobody asked about.

const { P_HISTORY, P_HIST_BLK, P_HIST_WATCH } = require('./constants')
const { kBlock, kScriptBlkFromBuf, kStoredBlk, h2b, b2h, pb, rangeEnd } = require('./key_codec')
const { kHistory, kHistoryBlock, kHistoryWatch, WATCH_FIELD } = require('./history_keys')
const { decodeBlock, decodeScriptBlk } = require('./value_codec')

// A value: [received(8)][sent(8)][blockTime(4)] = 20 bytes, amounts in base units.
const HISTORY_VALUE_SIZE = 20

// Most A records one address scan may step over in one read before it stops and
// reports where it stopped. Time bounds are filters, not seeks (block times are
// not monotonic in height), so without this a narrow time window over a large
// address would walk its whole history in one request.
const HISTORY_SCAN_MAX = 2500

function encodeHistory(received, sent, time) {
    const buf = Buffer.alloc(HISTORY_VALUE_SIZE)
    buf.writeBigUInt64BE(received, 0)
    buf.writeBigUInt64BE(sent, 8)
    buf.writeUInt32BE(time >>> 0, 16)
    return buf
}

function decodeHistory(buf) {
    return { received: buf.readBigUInt64BE(0), sent: buf.readBigUInt64BE(8), time: buf.readUInt32BE(16) }
}

function heightBuf(height) {
    const buf = Buffer.alloc(4)
    buf.writeUInt32BE(height, 0)
    return buf
}

// The key one address scan starts from: just past the cursor when paging,
// else the newest height the caller allows, else the address's first key.
function scanStart(scriptBuf, { toHeight, after }) {
    const prefix = Buffer.concat([pb(P_HISTORY), scriptBuf])
    let start = prefix
    if (toHeight != null) start = Buffer.concat([prefix, heightBuf(0xFFFFFFFF - toHeight)])
    if (after) {
        const cursorKey = kHistory(scriptBuf, after.height, after.txid)
        if (Buffer.compare(cursorKey, start) > 0) start = cursorKey
    }
    return { prefix, start }
}

// True when an entry falls inside the caller's time window.
function inTimeWindow(time, { fromTime, toTime }) {
    if (fromTime != null && time < fromTime) return false
    if (toTime != null && time > toTime) return false
    return true
}

// Reads one address's rows from the shared iterator, already seeked to its start.
// Stops at the address's last key, below fromHeight, or, while an in-range key is
// still ahead, at limit rows or the scan ceiling. `stoppedAt` is then the last
// position scanned ({height, txid}): every key of this address at or newer than
// it was read, so the caller can cut its page there. It is null when the address
// was read to the end of the requested range.
async function scanOneAddress(it, prefix, start, opts) {
    const rows = []
    let scanned = 0
    let last = null
    for (;;) {
        const entry = await it.next()
        if (entry === undefined) return { rows, stoppedAt: null }
        const [key, value] = entry
        if (key.length !== 69 || Buffer.compare(key.subarray(0, 33), prefix) !== 0) return { rows, stoppedAt: null }
        if (opts.after && key.equals(start)) continue
        const height = 0xFFFFFFFF - key.readUInt32BE(33)
        if (opts.fromHeight != null && height < opts.fromHeight) return { rows, stoppedAt: null }
        if (rows.length === opts.limit || scanned === HISTORY_SCAN_MAX) return { rows, stoppedAt: last }
        scanned++
        last = { height, txid: b2h(key.subarray(37, 69)) }
        const row = decodeHistory(value)
        if (inTimeWindow(row.time, opts)) rows.push({ ...last, ...row })
    }
}

// One watch-list record into its entry, by field.
function readWatchRecord(entry, field, value) {
    if (field === WATCH_FIELD.START) entry.start = value.readUInt32BE(0)
    else if (field === WATCH_FIELD.LIVE) entry.liveFrom = value.readUInt32BE(0)
    else if (field === WATCH_FIELD.PROGRESS) entry.progress = JSON.parse(value.toString())
}

module.exports = {
    // Stages one coin movement for (script, tx) into the open batch, summed into
    // any movement already staged for the pair, when the script is in the watch
    // snapshot the sync loop took for this block (historyScripts, latin1 keys).
    // The height and time come from the block's staged B record, so the mempool
    // store, which stages none, never writes here. A (script, height, txid) key is
    // only ever written by the block holding that tx, inside that block's batch,
    // so the staged value is the whole prior sum.
    async addHistoryMovement({ script, blockHash, txid, received = 0n, sent = 0n }) {
        if (!blockHash || !this.historyScripts || !this.historyScripts.has(script.toString('latin1'))) return false
        const blkVal = this.getTransactionValue(kBlock(blockHash))
        if (blkVal == null) return false
        const { h, t } = decodeBlock(blkVal)
        const key = kHistory(script, h, txid)
        const staged = this.getTransactionValue(key)
        const prior = staged != null ? decodeHistory(staged) : { received: 0n, sent: 0n }
        await this.addTransaction("put", key, encodeHistory(prior.received + received, prior.sent + sent, t))
        return await this.addTransaction("put", kHistoryBlock(blockHash, script, txid), heightBuf(h))
    },

    // Reorg unwind: deletes every A record the block wrote, and its V records.
    async removeHistoryInBlock(blockHash) {
        const prefixBuf = Buffer.concat([pb(P_HIST_BLK), h2b(blockHash)])
        for await (const [key, value] of this.db.iterator({ gte: prefixBuf, lte: rangeEnd(prefixBuf) })) {
            // V key: [V(1)][blockHash(32)][scriptHash(32)][txid(32)]; value: [height(4)]
            const aKey = kHistory(key.subarray(33, 65), value.readUInt32BE(0), b2h(key.subarray(65, 97)))
            await this.addTransaction("del", aKey)
            await this.addTransaction("del", key)
        }
    },

    // Aged-out block: drops only its V records. Its A records are the history
    // itself and stay; V's one reader is the reorg unwind above, which the
    // depth guard keeps inside the undo window.
    async removeHistoryBlockIndexOnly(blockHash) {
        const prefixBuf = Buffer.concat([pb(P_HIST_BLK), h2b(blockHash)])
        for await (const key of this.db.keys({ gte: prefixBuf, lte: rangeEnd(prefixBuf) })) {
            await this.addTransaction("del", key)
        }
    },

    // Reads up to opts.limit rows per script hash with ONE iterator: the hashes are
    // walked in ascending order and the iterator is seeked forward to each one, so
    // the store sees one cursor however many addresses the request names.
    // Returns, per hash in input order, { rows, stoppedAt }.
    async getHistoryRows(scriptBufs, opts) {
        const order = scriptBufs.map((buf, i) => ({ buf, i })).sort((a, b) => Buffer.compare(a.buf, b.buf))
        const out = new Array(scriptBufs.length)
        const it = this.db.iterator({ gte: pb(P_HISTORY), lte: rangeEnd(pb(P_HISTORY)) })
        try {
            for (const { buf, i } of order) {
                const { prefix, start } = scanStart(buf, opts)
                it.seek(start)
                out[i] = await scanOneAddress(it, prefix, start, opts)
            }
        } finally {
            await it.close()
        }
        return out
    },

    // The whole watch list, read once at start: script hex -> { start, liveFrom, progress }.
    async getHistoryWatchRecords() {
        const entries = new Map()
        for await (const [key, value] of this.db.iterator({ gte: pb(P_HIST_WATCH), lte: rangeEnd(pb(P_HIST_WATCH)) })) {
            if (key.length !== 34) continue
            const hex = b2h(key.subarray(1, 33))
            if (!entries.has(hex)) entries.set(hex, { start: null, liveFrom: null, progress: null })
            readWatchRecord(entries.get(hex), key[33], value)
        }
        return entries
    },

    // First-seen heights (S records) for a list of script hashes, in one read; null where unseen.
    async getFirstSeenHeights(scriptBufs) {
        if (scriptBufs.length === 0) return []
        const values = await this.db.getMany(scriptBufs.map((buf) => kScriptBlkFromBuf(buf)))
        return values.map((v) => (v == null ? null : decodeScriptBlk(v).h))
    },

    // Writes newly watched addresses ([{ script, start, progress }]) in one batch.
    async addHistoryWatches(adds) {
        if (adds.length === 0) return
        await this.db.batch(adds.flatMap(({ script, start, progress }) => [
            { type: 'put', key: kHistoryWatch(script, WATCH_FIELD.START), value: heightBuf(start) },
            { type: 'put', key: kHistoryWatch(script, WATCH_FIELD.PROGRESS), value: Buffer.from(JSON.stringify(progress)) },
        ]))
    },

    // The sync loop's record of the first block it staged with a watched address:
    // staged into the open batch when one is open, else written straight away.
    async setHistoryLiveFrom(script, height, { staged }) {
        const key = kHistoryWatch(script, WATCH_FIELD.LIVE)
        if (staged) return await this.addTransaction("put", key, heightBuf(height))
        return await this.db.put(key, heightBuf(height))
    },

    // Stages a restarted backfill's START and PROGRESS into the open batch (a rollback's).
    async stageHistoryRestart(script, start, progress) {
        await this.addTransaction("put", kHistoryWatch(script, WATCH_FIELD.START), heightBuf(start))
        return await this.addTransaction("put", kHistoryWatch(script, WATCH_FIELD.PROGRESS), Buffer.from(JSON.stringify(progress)))
    },

    // For each block hash: its committed height (null when this store holds no B
    // record for it) and whether it is still inside the undo window (has an N
    // record), read in one call.
    async getBackfillBlockChecks(hashes) {
        const values = await this.db.getMany([...hashes.map((h) => kBlock(h)), ...hashes.map((h) => kStoredBlk(h))])
        return hashes.map((hash, i) => ({
            height: values[i] == null ? null : decodeBlock(values[i]).h,
            inWindow: values[hashes.length + i] != null,
        }))
    },

    // One backfill chunk in one batch: absolute A rows (and their V records for
    // blocks the reorg unwind can still reach) plus each address's progress.
    // rows: [{ script, height, txid, received, sent, time, blockHash, indexed }];
    // progress: [{ script, record }]. The caller holds the store-commit lock.
    async writeHistoryBackfill(rows, progress) {
        const ops = []
        for (const r of rows) {
            ops.push({ type: 'put', key: kHistory(r.script, r.height, r.txid), value: encodeHistory(r.received, r.sent, r.time) })
            if (r.indexed) ops.push({ type: 'put', key: kHistoryBlock(r.blockHash, r.script, r.txid), value: heightBuf(r.height) })
        }
        for (const { script, record } of progress) {
            ops.push({ type: 'put', key: kHistoryWatch(script, WATCH_FIELD.PROGRESS), value: Buffer.from(JSON.stringify(record)) })
        }
        if (ops.length > 0) await this.db.batch(ops)
    },
}
