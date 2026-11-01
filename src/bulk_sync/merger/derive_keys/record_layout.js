'use strict'

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
 * XChain UTXO Tracker - Bulk Sync Derive-Keys Record Layout
 *
 ********************************************************************/

const fs   = require('fs')
const path = require('path')

const { externalSort }         = require('../external_sort.js')

// Take the prefix bytes from the live store so a seeded DB can never carry a
// prefix the live tracker does not read (LAYOUT is pinned by a parity test).
const {
    P_BLOCK, P_TX, P_INPUT, P_OUTPUT, P_OUT_HINT, P_IN_HINT,
    P_STORED_BLK, P_SCRIPT_BLK, P_OUT_BLK, P_BLK_SCRIPT,
    P_TX_EXACT, P_TX_BLOCK_RECOVERY,
} = require('../../../store/level_up_db/constants.js')

// The parse-stream record widths and field offsets, single-sourced in writers.js.
// Format 2 outputs are 113 bytes (with the trailing coinbase flag) and spends 68;
// callers pass opts.outputsRecordSize read from the dump header.
const {
    OUTPUTS_RECORD_SIZE, SPENDS_RECORD_SIZE, HEADER_SIZE: OUTPUTS_HEADER_SIZE,
    OUT_TXID, OUT_VOUT, OUT_VALUE, OUT_HEIGHT, OUT_SCRIPT, OUT_BLOCK, OUT_COINBASE,
    SPD_PREV_TXID, SPD_PREV_VOUT, SPD_SPENDER_TXID,
} = require('../../writers.js')

// Per-prefix (keySize, valueSize, recordSize). Each width must equal what the
// live key_codec builder and value_codec encoder produce for that prefix; the
// bulk-sync layout parity regression test fails when they drift.
const LAYOUT = {
    B: { keySize: 33, valSize: 40, recordSize:  73 },
    T: { keySize: 33, valSize: 32, recordSize:  65 },
    I: { keySize: 37, valSize: 32, recordSize:  69 },
    O: { keySize: 69, valSize: 45, recordSize: 114 },
    H: { keySize: 37, valSize: 32, recordSize:  69 },
    J: { keySize: 69, valSize:  0, recordSize:  69 },
    N: { keySize: 33, valSize:  0, recordSize:  33 },
    S: { keySize: 33, valSize:  4, recordSize:  37 },
    W: { keySize: 69, valSize: 32, recordSize: 101 },
    Z: { keySize: 65, valSize:  0, recordSize:  65 },
}

function noop() {}

function ensureDir(p) {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true })
}

// Removes the L.json and every named prefix file an earlier derive left in outDir.
// The keys dir is reused across runs, and a file this run does not write (T/X/Y with
// txIndex off, I/J with removeSpent on) would otherwise load as this run's data.
// L.json goes first, so a derive that stops partway leaves the loader its
// missing-L.json refusal instead of a mixed set.
function clearPriorDeriveOutputs(outDir, prefixes) {
    fs.rmSync(path.join(outDir, 'L.json'), { force: true })
    for (const pfx of new Set(prefixes)) fs.rmSync(path.join(outDir, pfx + '.dat'), { force: true })
}

// Fixed-record writer with no header, for (key||value) prefix files and
// intermediate unsorted streams.
class FlatWriter {
    constructor(filePath, recordSize) {
        this._fd         = fs.openSync(filePath, 'w')
        this._recordSize = recordSize
        const cap = Math.max(1, Math.floor((256 * 1024) / recordSize))
        this._buf    = Buffer.alloc(cap * recordSize)
        this._len    = 0
        this._count  = 0
        this._closed = false
    }
    write(slotFiller) {
        const off = this._len * this._recordSize
        slotFiller(this._buf, off)
        this._len++
        this._count++
        if (this._len * this._recordSize + this._recordSize > this._buf.length) this.flush()
    }
    flush() {
        if (this._len === 0) return
        fs.writeSync(this._fd, this._buf, 0, this._len * this._recordSize)
        this._len = 0
    }
    get count() { return this._count }
    close() {
        if (this._closed) return
        this._closed = true
        this.flush()
        try { fs.closeSync(this._fd) } catch (_) {}
    }
}

async function sortByKey(inputPath, outputPath, recordSize, keySize, tmpDir, ramBudgetBytes) {
    return externalSort({
        inputPath, outputPath,
        recordSize, keySize,
        ramBudgetBytes,
        tmpDir,
    })
}

module.exports = {
    P_BLOCK, P_TX, P_INPUT, P_OUTPUT, P_OUT_HINT, P_IN_HINT,
    P_STORED_BLK, P_SCRIPT_BLK, P_OUT_BLK, P_BLK_SCRIPT,
    P_TX_EXACT, P_TX_BLOCK_RECOVERY,
    OUTPUTS_RECORD_SIZE, SPENDS_RECORD_SIZE, OUTPUTS_HEADER_SIZE,
    OUT_TXID, OUT_VOUT, OUT_VALUE, OUT_HEIGHT, OUT_SCRIPT, OUT_BLOCK, OUT_COINBASE,
    SPD_PREV_TXID, SPD_PREV_VOUT, SPD_SPENDER_TXID,
    LAYOUT, noop, ensureDir, clearPriorDeriveOutputs, FlatWriter, sortByKey,
}
