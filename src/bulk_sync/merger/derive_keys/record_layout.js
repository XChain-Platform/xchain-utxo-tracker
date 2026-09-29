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

const { externalSort }         = require('../external_sort.js')

// Take the prefix bytes from the live store so a seeded DB can never carry a
// prefix the live tracker does not read (LAYOUT is pinned by a parity test).
const {
    P_BLOCK, P_TX, P_INPUT, P_OUTPUT, P_OUT_HINT, P_IN_HINT,
    P_STORED_BLK, P_SCRIPT_BLK, P_OUT_BLK, P_BLK_SCRIPT,
} = require('../../../store/level_up_db/constants.js')

// Legacy outputs record size. New dumps are 121 bytes (trailing coinbase flag);
// callers pass opts.outputsRecordSize (read from the dump header) so both
// widths merge. Kept as the default for legacy callers that omit it.
const OUTPUTS_RECORD_SIZE = 120
const OUTPUTS_RECORD_SIZE_CB = 121
const SPENDS_RECORD_SIZE  = 20
const OUTPUTS_HEADER_SIZE = 64

// Per-prefix (keySize, valueSize, recordSize). Each width must equal what the
// live key_codec builder and value_codec encoder produce for that prefix; the
// bulk-sync layout parity regression test fails when they drift.
const LAYOUT = {
    B: { keySize: 33, valSize: 40, recordSize:  73 },
    T: { keySize:  9, valSize: 32, recordSize:  41 },
    I: { keySize: 13, valSize:  8, recordSize:  21 },
    O: { keySize: 45, valSize: 45, recordSize:  90 },
    H: { keySize: 13, valSize: 32, recordSize:  45 },
    J: { keySize: 21, valSize:  0, recordSize:  21 },
    N: { keySize: 33, valSize:  0, recordSize:  33 },
    S: { keySize: 33, valSize:  4, recordSize:  37 },
    W: { keySize: 45, valSize: 32, recordSize:  77 },
    Z: { keySize: 65, valSize:  0, recordSize:  65 },
}

function noop() {}

function ensureDir(p) {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true })
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
    OUTPUTS_RECORD_SIZE, OUTPUTS_RECORD_SIZE_CB, SPENDS_RECORD_SIZE,
    OUTPUTS_HEADER_SIZE,
    LAYOUT, noop, ensureDir, FlatWriter, sortByKey,
}
