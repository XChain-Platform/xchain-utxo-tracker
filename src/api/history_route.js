/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************/
'use strict'

// POST /history: confirmed native coin history for up to HISTORY_ADDRESS_MAX
// addresses in one request, the shape a wallet's balance-over-time chart reads.
// The body follows the explorer's batch routes ({"addresses":[..]}, the same
// cap counted before deduplication, the same refusal codes), so the explorer
// can pass it through unchanged. The tracker keeps history only for addresses
// asked about here: a first request watches the address (within the per-IP and
// watch-list caps) and starts a background backfill of its past, and the answer
// says per address whether that history is complete yet.

const { sendAddressError } = require('./errors.js')

// The explorer's BATCH_ADDRESS_MAX: a wallet's worst per-chain address count.
const HISTORY_ADDRESS_MAX = 20

// Rows per address per page when the caller names no limit, and the most it may ask for.
const HISTORY_LIMIT_DEFAULT = 100
const HISTORY_LIMIT_MAX = 1000

// Highest height an A key can hold (its height field stores 0xFFFFFFFF - height).
const HEIGHT_MAX = 0xFFFFFFFE
const TIME_MAX = 0xFFFFFFFF

function refusal(error, code){
    return { refusal: { error, code } }
}

// An optional non-negative integer bound from the body, or a refusal naming it.
function readBound(body, name, max){
    const raw = body[name]
    if (raw === undefined || raw === null) return { value: null }
    if (!Number.isSafeInteger(raw) || raw < 0 || raw > max) {
        return refusal(name + ' must be an integer from 0 to ' + max, 'BAD_REQUEST')
    }
    return { value: raw }
}

// The cursor a previous page returned: "<height>:<64-hex txid>".
function readCursor(cursor){
    if (cursor === undefined || cursor === null) return { value: null }
    const m = typeof cursor === 'string' ? /^(0|[1-9][0-9]{0,9}):([0-9a-f]{64})$/.exec(cursor) : null
    if (!m || Number(m[1]) > HEIGHT_MAX) return refusal('cursor must be the cursor a previous page returned', 'INVALID_CURSOR')
    return { value: { height: Number(m[1]), txid: m[2] } }
}

function readLimit(raw){
    if (raw === undefined || raw === null) return { value: HISTORY_LIMIT_DEFAULT }
    if (!Number.isSafeInteger(raw) || raw <= 0) return refusal('limit must be a positive integer', 'BAD_REQUEST')
    return { value: Math.min(raw, HISTORY_LIMIT_MAX) }
}

// The addresses, deduplicated in request order, or a refusal.
function readAddresses(body){
    const list = Array.isArray(body.addresses) ? body.addresses : null
    if (list === null || list.length === 0 || list.some((entry) => typeof entry !== 'string')) {
        return refusal('addresses must be a non-empty array of address strings', 'INVALID_ADDRESSES')
    }
    // Counted before deduplication: the cap bounds what the caller sent.
    if (list.length > HISTORY_ADDRESS_MAX) {
        return refusal('Too many addresses (max ' + HISTORY_ADDRESS_MAX + ')', 'TOO_MANY_ADDRESSES')
    }
    return { value: [...new Set(list)] }
}

// Validates a request body into { addresses, opts } or { refusal }.
function parseHistoryRequest(body){
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return refusal('body must be a JSON object with an addresses array', 'INVALID_ADDRESSES')
    }
    const fields = {
        addresses: readAddresses(body),
        fromHeight: readBound(body, 'from_height', HEIGHT_MAX),
        toHeight: readBound(body, 'to_height', HEIGHT_MAX),
        fromTime: readBound(body, 'from_time', TIME_MAX),
        toTime: readBound(body, 'to_time', TIME_MAX),
        limit: readLimit(body.limit),
        after: readCursor(body.cursor)
    }
    const refused = Object.values(fields).find((field) => field.refusal)
    if (refused) return refused
    const opts = {}
    for (const [name, field] of Object.entries(fields)) if (name !== 'addresses') opts[name] = field.value
    if ((opts.fromHeight !== null && opts.toHeight !== null && opts.fromHeight > opts.toHeight)
        || (opts.fromTime !== null && opts.toTime !== null && opts.fromTime > opts.toTime)) {
        return refusal('a from_ bound must not exceed its to_ bound', 'BAD_REQUEST')
    }
    return { addresses: fields.addresses.value, opts }
}

function registerHistoryRoute({ app, requestGate, tracker, setFreshnessHeaders }){
    // Held on the request gate for the whole read, like every other store read.
    app.post('/history', requestGate.hold(async (req, res) => {
        const parsed = parseHistoryRequest(req.body)
        if (parsed.refusal) return res.status(400).json(parsed.refusal)
        try {
            // req.ip is the per-IP limiter's key too: the source a new watch slot is charged to.
            const read = await tracker.getNativeHistory(parsed.addresses, parsed.opts, { ip: req.ip })
            const sync = await setFreshnessHeaders(res, read.committedHeight, read)
            if (read.cursor) res.set('X-Next-Cursor', read.cursor)
            res.json({
                transactions: read.transactions,
                cursor: read.cursor,
                addresses: read.addressStatus,
                sync
            })
        } catch (err) {
            if (err && err.code === 'INVALID_ADDRESS') return res.status(400).json({ error: err.message, code: err.code })
            if (err && err.code === 'NOT_READY') return res.status(503).json({ error: err.message, code: err.code })
            sendAddressError(res, err)
        }
    }))
}

module.exports = { registerHistoryRoute, parseHistoryRequest, HISTORY_ADDRESS_MAX, HISTORY_LIMIT_MAX }
