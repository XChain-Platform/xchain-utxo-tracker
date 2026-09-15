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

const { h2b, b2h } = require('./key_codec')
const { ZERO_HASH } = require('./constants')

// Value encoders / decoders

// B value: [height(4)][timestamp(4)][previousHash(32)] = 40 bytes
function encodeBlock(height, timestamp, previousHashHex) {
    if (previousHashHex.length !== 64) {
        throw new Error(`encodeBlock expects a 64-hex (32-byte) previousHash, got ${previousHashHex.length} chars`)
    }
    const buf = Buffer.alloc(40)
    buf.writeUInt32BE(height, 0)
    buf.writeUInt32BE(timestamp, 4)
    h2b(previousHashHex).copy(buf, 8)
    return buf
}

function decodeBlock(buf) {
    return {
        h:  buf.readUInt32BE(0),
        t:  buf.readUInt32BE(4),
        ph: b2h(buf.slice(8, 40))
    }
}

// T value: [blockHash(32)] = 32 bytes
function encodeTx(blockHashHex) {
    const hex = blockHashHex || ZERO_HASH
    if (hex.length !== 64) {
        throw new Error(`encodeTx expects a 64-hex (32-byte) blockHash, got ${hex.length} chars`)
    }
    return h2b(hex)
}

function decodeTx(buf)          { return { bh: b2h(buf.slice(0, 32)) } }

// I value: [txHash8(8)] = 8 bytes
function encodeInputVal(txHash8Hex) {
    if (txHash8Hex.length !== 16) {
        throw new Error(`encodeInputVal expects a 16-hex (8-byte) txid prefix, got ${txHash8Hex.length} chars`)
    }
    return h2b(txHash8Hex)
}

function encodeOutput(value, height, fullTxHashHex, isCoinbase = false) {
    // Non-coinbase outputs (the overwhelming majority) stay exactly 44 bytes, so
    // existing records and encodings are byte-identical; only coinbase outputs
    // grow by one flag byte. This keeps the change reindex-free: a legacy 44-byte
    // record decodes as non-coinbase, which is the behaviour before this flag existed.
    const buf = Buffer.alloc(isCoinbase ? 45 : 44)
    buf.writeBigUInt64BE(BigInt(value), 0)
    buf.writeInt32BE(height != null ? height : -1, 8)
    // A falsy fullTxHashHex leaves bytes 12..44 as the alloc-zeroed 0x00…00,
    // i.e. ZERO_HASH. decodeOutput maps that sentinel back to t: null, which
    // callers (getUtxosAddress) treat as "no full txid available". All current
    // insertion paths supply fullTxHash, so a zero hash on read means the record
    // predates this field; such a LevelDB must be re-indexed before use, since
    // the 8-byte O-key prefix is not a spendable txid.
    if (fullTxHashHex) {
        if (fullTxHashHex.length !== 64) {
            throw new Error(`encodeOutput expects a 64-hex (32-byte) fullTxHash, got ${fullTxHashHex.length} chars`)
        }
        h2b(fullTxHashHex).copy(buf, 12)
    }
    if (isCoinbase) buf[44] = 1
    return buf
}

function decodeOutput(buf) {
    const fullTxHash = b2h(buf.slice(12, 44))
    return {
        v: buf.readBigUInt64BE(0).toString(),
        h: buf.readInt32BE(8),
        // ZERO_HASH is the "no full txid" sentinel (see encodeOutput).
        t: fullTxHash === ZERO_HASH ? null : fullTxHash,
        // Optional coinbase flag; legacy 44-byte records read as false.
        // Optional coinbase flag (L-4); legacy 44-byte records read as false.
        cb: buf.length > 44 && buf[44] === 1
    }
}

// H value: [scriptPubKey(32)] = 32 bytes
function encodeOutHint(scriptHex) {
    if (scriptHex.length !== 64) {
        throw new Error(`encodeOutHint expects a 64-hex (32-byte) scriptPubKey, got ${scriptHex.length} chars`)
    }
    return h2b(scriptHex)
}

// S value: [height(4)] = 4 bytes
function encodeScriptBlk(height) {
    const buf = Buffer.alloc(4)
    buf.writeUInt32BE(height, 0)
    return buf
}

function decodeScriptBlk(buf) {
    return { h: buf.readUInt32BE(0) }
}

module.exports = { encodeBlock, decodeBlock, encodeTx, decodeTx, encodeInputVal, encodeOutput, decodeOutput, encodeOutHint, encodeScriptBlk, decodeScriptBlk }
