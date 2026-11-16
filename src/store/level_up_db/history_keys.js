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

// Key builders for the native history of watched addresses: the A rows, their
// V per-block reverse index, and the U watch list. Kept apart from key_codec.js
// because only the history feature reads or writes these families.

const { P_HISTORY, P_HIST_BLK, P_HIST_WATCH } = require('./constants')

function assertTxid(builder, hex) {
    if (typeof hex !== 'string' || hex.length !== 64) {
        throw new Error(`${builder} expects a 64-hex (32-byte) txid, got ${hex == null ? hex : hex.length + ' chars'}`)
    }
}

// Writes a 32-byte script hash given as a Buffer or as 64 hex into buf at offset.
// A wrong width throws for the same overrun-coincidence reason the key_codec builders guard.
function writeScriptHash(builder, buf, script, offset) {
    if (Buffer.isBuffer(script) ? script.length !== 32 : (typeof script !== 'string' || script.length !== 64)) {
        throw new Error(`${builder} expects a 32-byte scriptPubKey hash (Buffer or 64 hex)`)
    }
    if (Buffer.isBuffer(script)) script.copy(buf, offset, 0, 32)
    else buf.write(script, offset, 'hex')
}

// A key: [A][scriptHash(32)][~height(4)][txid(32)], one record per (watched address, tx).
// The height is stored as 0xFFFFFFFF - height, so a forward scan of one address
// reads its history newest block first, which is the order the history route serves.
function kHistory(script, height, txidHex) {
    if (!Number.isInteger(height) || height < 0 || height > 0xFFFFFFFE) {
        throw new Error(`kHistory expects a block height in 0..4294967294, got ${height}`)
    }
    assertTxid('kHistory', txidHex)
    const buf = Buffer.allocUnsafe(69)
    buf[0] = P_HISTORY
    writeScriptHash('kHistory', buf, script, 1)
    buf.writeUInt32BE(0xFFFFFFFF - height, 33)
    buf.write(txidHex, 37, 'hex')
    return buf
}

// V key: [V][blockHash(32)][scriptHash(32)][txid(32)], value the block height.
// Names every A record a block wrote, so a reorg unwind deletes exactly those, and
// is pruned once the block leaves the undo window, like W and Y.
function kHistoryBlock(blockHashHex, script, txidHex) {
    if (typeof blockHashHex !== 'string' || blockHashHex.length !== 64) {
        throw new Error(`kHistoryBlock expects a 64-hex (32-byte) blockHash`)
    }
    assertTxid('kHistoryBlock', txidHex)
    const buf = Buffer.allocUnsafe(97)
    buf[0] = P_HIST_BLK
    buf.write(blockHashHex, 1, 'hex')
    writeScriptHash('kHistoryBlock', buf, script, 33)
    buf.write(txidHex, 65, 'hex')
    return buf
}

// U key: [U][scriptHash(32)][field(1)]. One watched address is three records, each
// with one writer: START (the route, once), LIVE (the sync loop) and PROGRESS (the
// backfill), so no writer ever overwrites a field another one moved.
const WATCH_FIELD = Object.freeze({ START: 0x00, LIVE: 0x01, PROGRESS: 0x02 })

function kHistoryWatch(script, field) {
    if (!Object.values(WATCH_FIELD).includes(field)) throw new Error(`kHistoryWatch: unknown field ${field}`)
    const buf = Buffer.allocUnsafe(34)
    buf[0] = P_HIST_WATCH
    writeScriptHash('kHistoryWatch', buf, script, 1)
    buf[33] = field
    return buf
}

module.exports = { kHistory, kHistoryBlock, kHistoryWatch, WATCH_FIELD }
