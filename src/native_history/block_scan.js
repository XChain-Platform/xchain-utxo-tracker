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

// One decoded block's history rows for the addresses a backfill is rebuilding,
// by the same rules live ingest applies: every output paying the address is
// received (an OP_RETURN data output is not), and every input spending one of
// the address's outputs is sent. Spends are recognised from the address's own
// open outputs, which the backfill collects as it walks forward from the
// address's first-seen height, so no transaction index on the node is needed.

const { createHash } = require('crypto')

const COINBASE_INDEX = 0xFFFFFFFF

function prevoutKey(input){
    return Buffer.from(input.hash).reverse().toString('hex') + ':' + input.index
}

function isSpendingInput(input){
    const standard = ('standard_input' in input) ? input.standard_input : true
    return standard && input.index !== COINBASE_INDEX
}

// Adds a movement to the (address, tx) row it belongs to.
function addMovement(rows, state, txid, field, value){
    const key = state.hex + txid
    if (!rows.has(key)) rows.set(key, { state, txid, received: 0n, sent: 0n })
    rows.get(key)[field] += value
}

// The inputs of one transaction that spend an output an active address holds.
function scanInputs(tx, txid, active, rows){
    for (const input of tx.ins) {
        if (!isSpendingInput(input)) continue
        const outpoint = prevoutKey(input)
        for (const state of active) {
            const value = state.open.get(outpoint)
            if (value === undefined) continue
            state.open.delete(outpoint)
            addMovement(rows, state, txid, 'sent', value)
        }
    }
}

// The outputs of one transaction that pay an active address.
function scanOutputs(tx, txid, byScript, rows){
    tx.outs.forEach((output, vout) => {
        if (output.script[0] === 0x6a) return
        const state = byScript.get(createHash('sha256').update(output.script).digest('latin1'))
        if (!state) return
        const value = BigInt(output.value)
        state.open.set(txid + ':' + vout, value)
        addMovement(rows, state, txid, 'received', value)
    })
}

// Scans a block at `height` for every state whose next height it is, then moves
// those states past it. A state is { hex, latin, next, target, open: Map(outpoint -> value) }.
// Returns [{ state, txid, received, sent }].
function scanBlock(block, height, states){
    const active = states.filter((s) => s.next === height && height <= s.target)
    if (active.length === 0) return []
    const byScript = new Map(active.map((s) => [s.latin, s]))
    const rows = new Map()
    for (const tx of block.transactions) {
        const txid = tx.getId()
        // Inputs first: a transaction never spends its own outputs, and an earlier
        // transaction's outputs in this block are already open.
        scanInputs(tx, txid, active, rows)
        scanOutputs(tx, txid, byScript, rows)
    }
    for (const state of active) state.next = height + 1
    return [...rows.values()]
}

module.exports = { scanBlock }
