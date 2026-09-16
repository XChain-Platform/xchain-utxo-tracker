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

const { P_OUT_BLK, P_BLOCK, P_TX, P_INPUT, P_OUTPUT, P_OUT_HINT, P_IN_HINT, P_SCRIPT_BLK, P_BLK_SCRIPT, P_OUT_DEL, P_HINT_DEL, P_STORED_BLK } = require('./constants')

// Binary helpers

function h2b(hex) { return Buffer.from(hex, 'hex') }

function b2h(buf) { return Buffer.isBuffer(buf) ? buf.toString('hex') : buf }

function pb(p)    { return Buffer.from([p]) }

function idxBuf(n) {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(n >>> 0, 0)
    return b
}

// Parse an "<txHash8Hex>:<vout>" cursor: the txid (8-byte/16-hex O-key prefix)
// and vout of the last output returned by the previous page. Returns null on any
// malformed input so the caller rejects it rather than crashing the iterator.
function parseOutputCursor(cursor) {
    if (typeof cursor !== 'string') return null
    const sep = cursor.indexOf(':')
    if (sep <= 0) return null
    const txHash8Hex = cursor.slice(0, sep)
    const voutStr    = cursor.slice(sep + 1)
    if (!/^[0-9a-fA-F]{16}$/.test(txHash8Hex)) return null
    if (!/^\d+$/.test(voutStr)) return null
    const vout = Number(voutStr)
    if (!Number.isInteger(vout) || vout < 0 || vout > 0xFFFFFFFF) return null
    return { txHash8Hex: txHash8Hex.toLowerCase(), vout }
}

function rangeEnd(prefix) {
    // The 0xFF suffix must be at least as long as the longest key suffix of any
    // range scan, or a key whose suffix bytes are all 0xFF sorts above the
    // (shorter) inclusive `lte` bound and is silently dropped from the iterator.
    // A previous 12-byte suffix covered the common O/H/I/M scans (33-byte prefix
    // over 45-byte keys) but under-covered the reorg-consistency scans: K's
    // 33-byte prefix over 77-byte keys leaves a 44-byte suffix, and Z leaves a
    // 32-byte suffix. A dropped K key means a spent output is not restored on
    // reorg rollback (permanent balance under-count); a dropped Z key leaves a
    // stale first-seen (S) record.
    //
    // 64 bytes covers that 44-byte maximum with margin, and a longer all-0xFF
    // bound never bleeds into the next prefix (the differing prefix byte sorts
    // first) or excludes a valid key. The length is derived from prefix.length
    // rather than fixed, because getValuesFromKeyPattern accepts patterns as
    // short as 2 bytes, which over the 77-byte K key would leave a 75-byte
    // suffix that a fixed 64-byte bound would under-cover.
    const MAX_KEY_LEN = 77
    return Buffer.concat([prefix, Buffer.alloc(Math.max(64, MAX_KEY_LEN - prefix.length), 0xFF)])
}

// Normalize a key to a string for use as a JavaScript Map key.
// DB operations always use the original Buffer/string.
//
// Uses 'latin1' instead of 'hex': each byte maps to one char (vs 2 for hex),
// and the conversion is a plain byte-reinterpret rather than nibble-to-char,
// so both the allocation size and encoding cost are roughly halved. V8
// internalizes these the same way it internalizes hex strings.
function toMapKey(key) {
    return Buffer.isBuffer(key) ? key.toString('latin1') : key
}

// Key constructors
// Each constructor allocates a single Buffer and writes fields directly via
// buf.write(hex, offset, 'hex'): avoids the 3-5 temporary Buffers created by
// Buffer.concat + h2b + pb + idxBuf. At ~5M key builds per
// batch flush this is the largest single contributor to GC pressure.

function kBlock(blockHashHex) {
    // Same overrun-coincidence hazard the other builders guard against: a wrong-
    // length hash leaves uninitialized allocUnsafe garbage in the key (buf.write
    // stops at the first invalid nibble), yielding a nondeterministic key.
    if (blockHashHex.length !== 64) {
        throw new Error(`kBlock expects a 64-hex (32-byte) blockHash, got ${blockHashHex.length} chars`)
    }
    const buf = Buffer.allocUnsafe(33)
    buf[0] = P_BLOCK
    buf.write(blockHashHex, 1, 'hex')
    return buf
}

function kTx(txHash8Hex) {
    if (txHash8Hex.length !== 16) {
        throw new Error(`kTx expects a 16-hex (8-byte) txid prefix, got ${txHash8Hex.length} chars`)
    }
    const buf = Buffer.allocUnsafe(9)
    buf[0] = P_TX
    buf.write(txHash8Hex, 1, 'hex')
    return buf
}

function kInput(prevTxHash8Hex, idx) {
    // The I-key carries only the 8-byte (16-hex) txid prefix. Fail loudly if a
    // caller passes a full 64-hex txid: today that resolves to the right key
    // purely by buffer-overrun coincidence (write caps at the 12 free bytes,
    // then writeUInt32BE(idx,9) overwrites the overrun), so any future change to
    // this layout would silently make every getInput miss. Assert the contract.
    //
    // Two prev-txids sharing a 64-bit prefix alias to one I-key, and that stays
    // bounded: REMOVE_SPENT=true keeps I records out of the on-disk store entirely
    // (derive-keys skips I.dat for the same reason), so they exist only in the
    // ephemeral in-memory mempool store. Every getInput caller reads presence, never
    // the value, so an alias costs one outpoint a wrong pending-balance flag until
    // the next mempool poll, not a confirmed-balance error.
    if (prevTxHash8Hex.length !== 16) {
        throw new Error(`kInput expects a 16-hex (8-byte) txid prefix, got ${prevTxHash8Hex.length} chars`)
    }
    const buf = Buffer.allocUnsafe(13)
    buf[0] = P_INPUT
    buf.write(prevTxHash8Hex, 1, 'hex')
    buf.writeUInt32BE(idx >>> 0, 9)
    return buf
}

function kOutput(scriptHex, txHash8Hex, idx) {
    // Same overrun-coincidence hazard kInput() guards against: a wrong-length
    // scriptHex would overrun into the txHash8Hex field, which the next
    // .write() then silently overwrites back to a well-formed (wrong) key.
    if (scriptHex.length !== 64) {
        throw new Error(`kOutput expects a 64-hex (32-byte) scriptPubKey, got ${scriptHex.length} chars`)
    }
    if (txHash8Hex.length !== 16) {
        throw new Error(`kOutput expects a 16-hex (8-byte) txid prefix, got ${txHash8Hex.length} chars`)
    }
    const buf = Buffer.allocUnsafe(45)
    buf[0] = P_OUTPUT
    buf.write(scriptHex, 1, 'hex')
    buf.write(txHash8Hex, 33, 'hex')
    buf.writeUInt32BE(idx >>> 0, 41)
    return buf
}

function kOutHint(txHash8Hex, idx) {
    if (txHash8Hex.length !== 16) {
        throw new Error(`kOutHint expects a 16-hex (8-byte) txid prefix, got ${txHash8Hex.length} chars`)
    }
    const buf = Buffer.allocUnsafe(13)
    buf[0] = P_OUT_HINT
    buf.write(txHash8Hex, 1, 'hex')
    buf.writeUInt32BE(idx >>> 0, 9)
    return buf
}

function kInHint(txHash8Hex, prevTxHash8Hex, idx) {
    if (txHash8Hex.length !== 16) {
        throw new Error(`kInHint expects a 16-hex (8-byte) txid prefix, got ${txHash8Hex.length} chars`)
    }
    if (prevTxHash8Hex.length !== 16) {
        throw new Error(`kInHint expects a 16-hex (8-byte) prevTxHash prefix, got ${prevTxHash8Hex.length} chars`)
    }
    const buf = Buffer.allocUnsafe(21)
    buf[0] = P_IN_HINT
    buf.write(txHash8Hex, 1, 'hex')
    buf.write(prevTxHash8Hex, 9, 'hex')
    buf.writeUInt32BE(idx >>> 0, 17)
    return buf
}

function kScriptBlk(scriptHex) {
    // Same overrun-coincidence hazard kScriptBlkFromBuf() guards against, and
    // reachable with caller-supplied hex via getOutputScriptBlock().
    if (scriptHex.length !== 64) {
        throw new Error(`kScriptBlk expects a 64-hex (32-byte) scriptPubKey, got ${scriptHex.length} chars`)
    }
    const buf = Buffer.allocUnsafe(33)
    buf[0] = P_SCRIPT_BLK
    buf.write(scriptHex, 1, 'hex')
    return buf
}

function kScriptBlkFromBuf(scriptBuf) {
    // Same overrun-coincidence hazard the hex builders guard against: .copy()
    // silently caps at the source length instead of throwing, so a short
    // scriptBuf would leave uninitialized allocUnsafe garbage in the key.
    if (scriptBuf.length !== 32) {
        throw new Error(`kScriptBlkFromBuf expects a 32-byte scriptPubKey buffer, got ${scriptBuf.length} bytes`)
    }
    const buf = Buffer.allocUnsafe(33)
    buf[0] = P_SCRIPT_BLK
    scriptBuf.copy(buf, 1, 0, 32)
    return buf
}

function kBlkScript(blockHashHex, scriptHex) {
    // Same overrun-coincidence hazard kBlkScriptFromBuf() guards against on both
    // fields: a wrong-length arg leaves allocUnsafe garbage in the key.
    if (blockHashHex.length !== 64) {
        throw new Error(`kBlkScript expects a 64-hex (32-byte) blockHash, got ${blockHashHex.length} chars`)
    }
    if (scriptHex.length !== 64) {
        throw new Error(`kBlkScript expects a 64-hex (32-byte) scriptPubKey, got ${scriptHex.length} chars`)
    }
    const buf = Buffer.allocUnsafe(65)
    buf[0] = P_BLK_SCRIPT
    buf.write(blockHashHex, 1, 'hex')
    buf.write(scriptHex, 33, 'hex')
    return buf
}

function kBlkScriptFromBuf(blockHashHex, scriptBuf) {
    if (blockHashHex.length !== 64) {
        throw new Error(`kBlkScriptFromBuf expects a 64-hex (32-byte) blockHash, got ${blockHashHex.length} chars`)
    }
    // Same overrun-coincidence hazard the hex builders guard against: .copy()
    // silently caps at the source length instead of throwing, so a short
    // scriptBuf would leave uninitialized allocUnsafe garbage in the key.
    if (scriptBuf.length !== 32) {
        throw new Error(`kBlkScriptFromBuf expects a 32-byte scriptPubKey buffer, got ${scriptBuf.length} bytes`)
    }
    const buf = Buffer.allocUnsafe(65)
    buf[0] = P_BLK_SCRIPT
    buf.write(blockHashHex, 1, 'hex')
    scriptBuf.copy(buf, 33, 0, 32)
    return buf
}

function kOutDel(blockHashHex, scriptHex, txHash8Hex, idx) {
    if (blockHashHex.length !== 64) {
        throw new Error(`kOutDel expects a 64-hex (32-byte) blockHash, got ${blockHashHex.length} chars`)
    }
    if (scriptHex.length !== 64) {
        throw new Error(`kOutDel expects a 64-hex (32-byte) scriptPubKey, got ${scriptHex.length} chars`)
    }
    if (txHash8Hex.length !== 16) {
        throw new Error(`kOutDel expects a 16-hex (8-byte) txid prefix, got ${txHash8Hex.length} chars`)
    }
    const buf = Buffer.allocUnsafe(77)
    buf[0] = P_OUT_DEL
    buf.write(blockHashHex, 1, 'hex')
    buf.write(scriptHex, 33, 'hex')
    buf.write(txHash8Hex, 65, 'hex')
    buf.writeUInt32BE(idx >>> 0, 73)
    return buf
}

function kHintDel(blockHashHex, txHash8Hex, idx) {
    if (blockHashHex.length !== 64) {
        throw new Error(`kHintDel expects a 64-hex (32-byte) blockHash, got ${blockHashHex.length} chars`)
    }
    if (txHash8Hex.length !== 16) {
        throw new Error(`kHintDel expects a 16-hex (8-byte) txid prefix, got ${txHash8Hex.length} chars`)
    }
    const buf = Buffer.allocUnsafe(45)
    buf[0] = P_HINT_DEL
    buf.write(blockHashHex, 1, 'hex')
    buf.write(txHash8Hex, 33, 'hex')
    buf.writeUInt32BE(idx >>> 0, 41)
    return buf
}

function kStoredBlk(blockHashHex) {
    if (blockHashHex.length !== 64) {
        throw new Error(`kStoredBlk expects a 64-hex (32-byte) blockHash, got ${blockHashHex.length} chars`)
    }
    const buf = Buffer.allocUnsafe(33)
    buf[0] = P_STORED_BLK
    buf.write(blockHashHex, 1, 'hex')
    return buf
}

// W key: creation-block reverse index. Keyed by the block an output was created
// in, so a rolled-back block can enumerate (and delete) the O/H entries it
// produced. Mirrors the K layout but keyed on the creation block rather than the
// spend block. Value is the 32-byte scriptPubKey needed to rebuild the O key.
function kOutBlk(blockHashHex, txHash8Hex, idx) {
    if (blockHashHex.length !== 64) {
        throw new Error(`kOutBlk expects a 64-hex (32-byte) blockHash, got ${blockHashHex.length} chars`)
    }
    if (txHash8Hex.length !== 16) {
        throw new Error(`kOutBlk expects a 16-hex (8-byte) txid prefix, got ${txHash8Hex.length} chars`)
    }
    const buf = Buffer.allocUnsafe(45)
    buf[0] = P_OUT_BLK
    buf.write(blockHashHex, 1, 'hex')
    buf.write(txHash8Hex, 33, 'hex')
    buf.writeUInt32BE(idx >>> 0, 41)
    return buf
}

// Build an O-prefixed output key from an already-binary scriptPubKey buffer
// (used in the input-removal path where the script is fetched from the H index).
function kOutputFromBuf(scriptPubKeyBuf, txHash8Hex, idx) {
    // Same overrun-coincidence hazard the hex builders guard against: .copy()
    // silently caps at the source length instead of throwing, so a short
    // scriptPubKeyBuf would leave uninitialized allocUnsafe garbage in the key.
    if (scriptPubKeyBuf.length !== 32) {
        throw new Error(`kOutputFromBuf expects a 32-byte scriptPubKey buffer, got ${scriptPubKeyBuf.length} bytes`)
    }
    if (txHash8Hex.length !== 16) {
        throw new Error(`kOutputFromBuf expects a 16-hex (8-byte) txid prefix, got ${txHash8Hex.length} chars`)
    }
    const buf = Buffer.allocUnsafe(45)
    buf[0] = P_OUTPUT
    scriptPubKeyBuf.copy(buf, 1, 0, 32)
    buf.write(txHash8Hex, 33, 'hex')
    buf.writeUInt32BE(idx >>> 0, 41)
    return buf
}

// Build a K-prefixed deleted-output key from a binary scriptPubKey buffer.
function kOutDelFromBuf(blockHashHex, scriptPubKeyBuf, txHash8Hex, idx) {
    if (blockHashHex.length !== 64) {
        throw new Error(`kOutDelFromBuf expects a 64-hex (32-byte) blockHash, got ${blockHashHex.length} chars`)
    }
    // Same overrun-coincidence hazard the hex builders guard against: .copy()
    // silently caps at the source length instead of throwing, so a short
    // scriptPubKeyBuf would leave uninitialized allocUnsafe garbage in the key.
    if (scriptPubKeyBuf.length !== 32) {
        throw new Error(`kOutDelFromBuf expects a 32-byte scriptPubKey buffer, got ${scriptPubKeyBuf.length} bytes`)
    }
    if (txHash8Hex.length !== 16) {
        throw new Error(`kOutDelFromBuf expects a 16-hex (8-byte) txid prefix, got ${txHash8Hex.length} chars`)
    }
    const buf = Buffer.allocUnsafe(77)
    buf[0] = P_OUT_DEL
    buf.write(blockHashHex, 1, 'hex')
    scriptPubKeyBuf.copy(buf, 33, 0, 32)
    buf.write(txHash8Hex, 65, 'hex')
    buf.writeUInt32BE(idx >>> 0, 73)
    return buf
}

module.exports = { h2b, b2h, pb, idxBuf, parseOutputCursor, rangeEnd, toMapKey, kBlock, kTx, kInput, kOutput, kOutHint, kInHint, kScriptBlk, kScriptBlkFromBuf, kBlkScript, kBlkScriptFromBuf, kOutDel, kHintDel, kStoredBlk, kOutBlk, kOutputFromBuf, kOutDelFromBuf }
