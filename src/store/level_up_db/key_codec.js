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

const { P_OUT_BLK, P_BLOCK, P_TX, P_INPUT, P_OUTPUT, P_OUT_HINT, P_IN_HINT, P_SCRIPT_BLK, P_BLK_SCRIPT, P_OUT_DEL, P_HINT_DEL, P_STORED_BLK, P_TX_EXACT, P_TX_BLOCK_RECOVERY } = require('./constants')

// Binary helpers

function h2b(hex) { return Buffer.from(hex, 'hex') }

function b2h(buf) { return Buffer.isBuffer(buf) ? buf.toString('hex') : buf }

function pb(p)    { return Buffer.from([p]) }

function idxBuf(n) {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(n >>> 0, 0)
    return b
}

// Parse an "<txidHex>:<vout>" cursor: the full txid (64 hex, as in the O key)
// and vout of the last output returned by the previous page. Returns null on any
// malformed input so the caller rejects it rather than crashing the iterator.
// A 16-hex cursor (the 8-byte txid form a layout 1 store issued) is malformed
// here too: it cannot name a layout 2 O key, so its client restarts the walk.
function parseOutputCursor(cursor) {
    if (typeof cursor !== 'string') return null
    const sep = cursor.indexOf(':')
    if (sep <= 0) return null
    const txidHex = cursor.slice(0, sep)
    const voutStr = cursor.slice(sep + 1)
    if (!/^[0-9a-fA-F]{64}$/.test(txidHex)) return null
    if (!/^\d+$/.test(voutStr)) return null
    const vout = Number(voutStr)
    if (!Number.isInteger(vout) || vout < 0 || vout > 0xFFFFFFFF) return null
    return { txidHex: txidHex.toLowerCase(), vout }
}

function rangeEnd(prefix) {
    // The 0xFF suffix must be at least as long as the longest key suffix of ANY
    // range scan, or a key whose leading suffix bytes are all 0xFF sorts above the
    // (shorter) inclusive `lte` bound and is silently dropped from the iterator.
    // The address scan ([O][scriptHash], 33 bytes) leaves a 36-byte [txid][vout]
    // suffix. The reorg-consistency scans are the longest: the K/P_OUT_DEL restore scan
    // uses a 33-byte [K+blockHash] prefix over 101-byte keys (68-byte suffix), the
    // M and W scans leave 36-byte suffixes, and the Z/P_BLK_SCRIPT scan a 32-byte
    // scriptHash suffix. A dropped K key means a spent output is NOT restored on a
    // reorg rollback (permanent balance under-count); a dropped Z key leaves a stale
    // first-seen (S) record. A longer all-0xFF upper bound never bleeds into the
    // next prefix (the differing prefix byte is compared first) and never excludes
    // a valid key.
    //
    // The suffix is sized so that prefix.length + suffix.length is at least the
    // longest key in the schema (101 bytes: K/P_OUT_DEL). The internal fixed-prefix
    // scans always leave >= 33-byte prefixes, but getValuesFromKeyPattern accepts
    // patterns as short as 2 bytes, which over a 101-byte K key leaves a 99-byte
    // suffix that a fixed 64-byte 0xFF bound would under-cover. Deriving the length
    // from the prefix keeps the bound valid for every scan while retaining the
    // 64-byte floor for the common fixed-prefix cases.
    const MAX_KEY_LEN = 101
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

// Every txid field in a key is the whole 32-byte txid (64 hex). A shorter
// field would let two transactions that share the leading bytes write the same
// key and overwrite or delete each other's records.
function assertTxid(builder, field, hex) {
    if (typeof hex !== 'string' || hex.length !== 64) {
        throw new Error(`${builder} expects a 64-hex (32-byte) ${field}, got ${hex == null ? hex : hex.length + ' chars'}`)
    }
}

function kTx(txidHex) {
    assertTxid('kTx', 'txid', txidHex)
    const buf = Buffer.allocUnsafe(33)
    buf[0] = P_TX
    buf.write(txidHex, 1, 'hex')
    return buf
}

function kInput(prevTxidHex, idx) {
    // A wrong-length txid would leave allocUnsafe bytes in the key or overrun
    // into the index field, which the writeUInt32BE then silently overwrites
    // back to a well-formed but wrong key; assert the width instead.
    //
    // I records live only in the in-memory mempool store: REMOVE_SPENT=true keeps
    // them out of the on-disk store (derive-keys skips I.dat for the same reason),
    // and every getInput caller reads presence, never the value. Keyed on the
    // whole prev txid, two spent outpoints never share an I key.
    assertTxid('kInput', 'prevTxid', prevTxidHex)
    const buf = Buffer.allocUnsafe(37)
    buf[0] = P_INPUT
    buf.write(prevTxidHex, 1, 'hex')
    buf.writeUInt32BE(idx >>> 0, 33)
    return buf
}

function kOutput(scriptHex, txidHex, idx) {
    // Same overrun-coincidence hazard kInput() guards against: a wrong-length
    // scriptHex would overrun into the txid field, which the next .write()
    // then silently overwrites back to a well-formed (wrong) key.
    if (scriptHex.length !== 64) {
        throw new Error(`kOutput expects a 64-hex (32-byte) scriptPubKey, got ${scriptHex.length} chars`)
    }
    assertTxid('kOutput', 'txid', txidHex)
    const buf = Buffer.allocUnsafe(69)
    buf[0] = P_OUTPUT
    buf.write(scriptHex, 1, 'hex')
    buf.write(txidHex, 33, 'hex')
    buf.writeUInt32BE(idx >>> 0, 65)
    return buf
}

function kOutHint(txidHex, idx) {
    assertTxid('kOutHint', 'txid', txidHex)
    const buf = Buffer.allocUnsafe(37)
    buf[0] = P_OUT_HINT
    buf.write(txidHex, 1, 'hex')
    buf.writeUInt32BE(idx >>> 0, 33)
    return buf
}

function kInHint(txidHex, prevTxidHex, idx) {
    assertTxid('kInHint', 'txid', txidHex)
    assertTxid('kInHint', 'prevTxid', prevTxidHex)
    const buf = Buffer.allocUnsafe(69)
    buf[0] = P_IN_HINT
    buf.write(txidHex, 1, 'hex')
    buf.write(prevTxidHex, 33, 'hex')
    buf.writeUInt32BE(idx >>> 0, 65)
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

function kOutDel(blockHashHex, scriptHex, txidHex, idx) {
    if (blockHashHex.length !== 64) {
        throw new Error(`kOutDel expects a 64-hex (32-byte) blockHash, got ${blockHashHex.length} chars`)
    }
    if (scriptHex.length !== 64) {
        throw new Error(`kOutDel expects a 64-hex (32-byte) scriptPubKey, got ${scriptHex.length} chars`)
    }
    assertTxid('kOutDel', 'txid', txidHex)
    const buf = Buffer.allocUnsafe(101)
    buf[0] = P_OUT_DEL
    buf.write(blockHashHex, 1, 'hex')
    buf.write(scriptHex, 33, 'hex')
    buf.write(txidHex, 65, 'hex')
    buf.writeUInt32BE(idx >>> 0, 97)
    return buf
}

function kHintDel(blockHashHex, txidHex, idx) {
    if (blockHashHex.length !== 64) {
        throw new Error(`kHintDel expects a 64-hex (32-byte) blockHash, got ${blockHashHex.length} chars`)
    }
    assertTxid('kHintDel', 'txid', txidHex)
    const buf = Buffer.allocUnsafe(69)
    buf[0] = P_HINT_DEL
    buf.write(blockHashHex, 1, 'hex')
    buf.write(txidHex, 33, 'hex')
    buf.writeUInt32BE(idx >>> 0, 65)
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
function kOutBlk(blockHashHex, txidHex, idx) {
    if (blockHashHex.length !== 64) {
        throw new Error(`kOutBlk expects a 64-hex (32-byte) blockHash, got ${blockHashHex.length} chars`)
    }
    assertTxid('kOutBlk', 'txid', txidHex)
    const buf = Buffer.allocUnsafe(69)
    buf[0] = P_OUT_BLK
    buf.write(blockHashHex, 1, 'hex')
    buf.write(txidHex, 33, 'hex')
    buf.writeUInt32BE(idx >>> 0, 65)
    return buf
}

// X key: full txid -> blockHash. It is separate from T because X exists only
// for transactions indexed in confirmed blocks, while T also tracks mempool
// membership.
function kTxExact(txidHex) {
    if (txidHex.length !== 64) {
        throw new Error(`kTxExact expects a 64-hex (32-byte) txid, got ${txidHex.length} chars`)
    }
    const buf = Buffer.allocUnsafe(33)
    buf[0] = P_TX_EXACT
    buf.write(txidHex, 1, 'hex')
    return buf
}

// Y key: (blockHash, txid) -> full txid. Records which full transaction key a
// block created so rollback can remove only that block's T and X entries.
function kTxBlockRecovery(blockHashHex, txidHex) {
    if (blockHashHex.length !== 64) {
        throw new Error(`kTxBlockRecovery expects a 64-hex (32-byte) blockHash, got ${blockHashHex.length} chars`)
    }
    assertTxid('kTxBlockRecovery', 'txid', txidHex)
    const buf = Buffer.allocUnsafe(65)
    buf[0] = P_TX_BLOCK_RECOVERY
    buf.write(blockHashHex, 1, 'hex')
    buf.write(txidHex, 33, 'hex')
    return buf
}

// Build an O-prefixed output key from an already-binary scriptPubKey buffer
// (used in the input-removal path where the script is fetched from the H index).
function kOutputFromBuf(scriptPubKeyBuf, txidHex, idx) {
    // Same overrun-coincidence hazard the hex builders guard against: .copy()
    // silently caps at the source length instead of throwing, so a short
    // scriptPubKeyBuf would leave uninitialized allocUnsafe garbage in the key.
    if (scriptPubKeyBuf.length !== 32) {
        throw new Error(`kOutputFromBuf expects a 32-byte scriptPubKey buffer, got ${scriptPubKeyBuf.length} bytes`)
    }
    assertTxid('kOutputFromBuf', 'txid', txidHex)
    const buf = Buffer.allocUnsafe(69)
    buf[0] = P_OUTPUT
    scriptPubKeyBuf.copy(buf, 1, 0, 32)
    buf.write(txidHex, 33, 'hex')
    buf.writeUInt32BE(idx >>> 0, 65)
    return buf
}

// Build a K-prefixed deleted-output key from a binary scriptPubKey buffer.
function kOutDelFromBuf(blockHashHex, scriptPubKeyBuf, txidHex, idx) {
    if (blockHashHex.length !== 64) {
        throw new Error(`kOutDelFromBuf expects a 64-hex (32-byte) blockHash, got ${blockHashHex.length} chars`)
    }
    // Same overrun-coincidence hazard the hex builders guard against: .copy()
    // silently caps at the source length instead of throwing, so a short
    // scriptPubKeyBuf would leave uninitialized allocUnsafe garbage in the key.
    if (scriptPubKeyBuf.length !== 32) {
        throw new Error(`kOutDelFromBuf expects a 32-byte scriptPubKey buffer, got ${scriptPubKeyBuf.length} bytes`)
    }
    assertTxid('kOutDelFromBuf', 'txid', txidHex)
    const buf = Buffer.allocUnsafe(101)
    buf[0] = P_OUT_DEL
    buf.write(blockHashHex, 1, 'hex')
    scriptPubKeyBuf.copy(buf, 33, 0, 32)
    buf.write(txidHex, 65, 'hex')
    buf.writeUInt32BE(idx >>> 0, 97)
    return buf
}

module.exports = { h2b, b2h, pb, idxBuf, parseOutputCursor, rangeEnd, toMapKey, kBlock, kTx, kInput, kOutput, kOutHint, kInHint, kScriptBlk, kScriptBlkFromBuf, kBlkScript, kBlkScriptFromBuf, kOutDel, kHintDel, kStoredBlk, kOutBlk, kTxExact, kTxBlockRecovery, kOutputFromBuf, kOutDelFromBuf }
