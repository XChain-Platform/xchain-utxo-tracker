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

// Encode a Bitcoin-style varint as lowercase hex (inverse of readVarint).
// Keep in sync with xchain-decoder/src/chain/blockchain_connector.js encodeVarintHex.
function encodeVarintHex(value) {
    if (value < 0xFD) {
        return value.toString(16).padStart(2, '0')
    }
    if (value <= 0xFFFF) {
        const buf = Buffer.alloc(3)
        buf[0] = 0xFD
        buf.writeUInt16LE(value, 1)
        return buf.toString('hex')
    }
    if (value <= 0xFFFFFFFF) {
        const buf = Buffer.alloc(5)
        buf[0] = 0xFE
        buf.writeUInt32LE(value, 1)
        return buf.toString('hex')
    }
    // A block can never hold 2^32 txs; refuse rather than emit a wrong varint.
    throw new Error('encodeVarintHex: value out of supported range: ' + value)
}

// Decode a Bitcoin-style varint from `buf` at `offset`.
// Returns { value, bytes } where `bytes` is the number of bytes consumed.
// Keep in sync with xchain-decoder/src/chain/blockchain_connector.js readVarint.
function readVarint(buf, offset) {
    const first = buf[offset]
    if (first < 0xFD) return { value: first, bytes: 1 }
    if (first === 0xFD) return { value: buf.readUInt16LE(offset + 1), bytes: 3 }
    if (first === 0xFE) return { value: buf.readUInt32LE(offset + 1), bytes: 5 }
    // 0xFF: 8-byte varint; safe for our sizes (branch counts are small)
    const lo = buf.readUInt32LE(offset + 1)
    const hi = buf.readUInt32LE(offset + 5)
    return { value: hi * 0x100000000 + lo, bytes: 9 }
}

// Parse the AuxPoW section from a raw block Buffer starting at byte offset `start`
// (immediately after the 80-byte standard header). Returns the byte offset of the
// first byte after the AuxPoW section (i.e. where the tx-count varint begins).
// AuxPoW layout: coinbase tx | parent block hash (32 B) |
//                coinbase merkle branch (varint count + count*32 B + 4 B index) |
//                chain merge-mining branch (same layout) |
//                parent block header (80 B)
// Throws if the buffer is too short or structurally invalid.
// Keep in sync with xchain-decoder/src/chain/blockchain_connector.js skipAuxPow.
function skipAuxPow(buf, start) {
    let offset = start

    // Skip the coinbase transaction (a full serialized Bitcoin tx).
    // version (4) | [segwit marker+flag (2, optional)] | inputs | outputs | [witness] | locktime (4)
    if (offset + 4 > buf.length) throw new Error('AuxPoW parse: buffer too short for coinbase version')
    offset += 4  // version

    // Detect SegWit marker (0x00 flag byte means segwit)
    const hasSegwit = (buf[offset] === 0x00)
    if (hasSegwit) offset += 2  // skip marker + flag

    // Inputs
    const insVI = readVarint(buf, offset)
    offset += insVI.bytes
    const nIns = insVI.value
    for (let i = 0; i < nIns; i++) {
        if (offset + 36 > buf.length) throw new Error('AuxPoW parse: buffer too short for coinbase input prevout')
        offset += 36  // prev hash (32) + prev index (4)
        const scriptVI = readVarint(buf, offset)
        offset += scriptVI.bytes + scriptVI.value  // script length + script bytes
        if (offset + 4 > buf.length) throw new Error('AuxPoW parse: buffer too short for coinbase input sequence')
        offset += 4  // sequence
    }

    // Outputs
    const outsVI = readVarint(buf, offset)
    offset += outsVI.bytes
    const nOuts = outsVI.value
    for (let i = 0; i < nOuts; i++) {
        if (offset + 8 > buf.length) throw new Error('AuxPoW parse: buffer too short for coinbase output value')
        offset += 8  // value (8 bytes)
        const scriptVI = readVarint(buf, offset)
        offset += scriptVI.bytes + scriptVI.value
    }

    // Witness data (only if segwit coinbase)
    if (hasSegwit) {
        for (let i = 0; i < nIns; i++) {
            const stackVI = readVarint(buf, offset)
            offset += stackVI.bytes
            const stackItems = stackVI.value
            for (let j = 0; j < stackItems; j++) {
                const itemVI = readVarint(buf, offset)
                offset += itemVI.bytes + itemVI.value
            }
        }
    }

    if (offset + 4 > buf.length) throw new Error('AuxPoW parse: buffer too short for coinbase locktime')
    offset += 4  // locktime

    // Parent block hash (32 bytes)
    if (offset + 32 > buf.length) throw new Error('AuxPoW parse: buffer too short for parent block hash')
    offset += 32

    // Coinbase merkle branch: varint count, count*32 B hashes, 4 B index
    const cbVI = readVarint(buf, offset)
    offset += cbVI.bytes
    if (offset + cbVI.value * 32 + 4 > buf.length) throw new Error('AuxPoW parse: buffer too short for coinbase branch')
    offset += cbVI.value * 32 + 4

    // Chain merge-mining branch: same layout
    const chainVI = readVarint(buf, offset)
    offset += chainVI.bytes
    if (offset + chainVI.value * 32 + 4 > buf.length) throw new Error('AuxPoW parse: buffer too short for chain branch')
    offset += chainVI.value * 32 + 4

    // Parent block header (80 bytes)
    if (offset + 80 > buf.length) throw new Error('AuxPoW parse: buffer too short for parent block header')
    offset += 80

    return offset
}

// Strip the AuxPoW section from a merge-mined block's hex, preserving the 80-byte
// (160 hex char) standard header. Two daemon behaviors are handled: an older daemon
// whose getblockheader already includes the AuxPoW bytes (length-based strip via the
// header/block length delta), and Dogecoin Core 1.14 whose getblockheader always
// returns exactly 160 chars, requiring the AuxPoW size to be parsed structurally from
// the block hex (skipAuxPow). Non-AuxPoW blocks pass through unchanged. Shared by the
// single-block (getBlockWithoutAuxPow) and batch (getBlocksBatchWithoutAuxPow) paths
// so a strip correction can never land in one and silently miss the other.
// Keep in sync with xchain-decoder/src/chain/blockchain_connector.js stripAuxPowFromBlockHex;
// xchain-decoder/test/unit/auxpow_strip_parity.test.js asserts byte identity of the two
// function bodies, so a strip correction here must land there too.
function stripAuxPowFromBlockHex(headerHex, blockHex) {
    const dataToRemove = headerHex.length - 160  // 160 hex chars = 80-byte standard header
    if (dataToRemove > 0) {
        // Legacy path: getblockheader included AuxPoW bytes (older daemon).
        return blockHex.substring(0, 160) + blockHex.substring(160 + dataToRemove)
    }
    if (blockHex.length >= 8) {
        const versionLE = parseInt(blockHex.substring(0, 8), 16)
        const version = ((versionLE & 0xFF) << 24) | (((versionLE >> 8) & 0xFF) << 16) |
                        (((versionLE >> 16) & 0xFF) << 8) | ((versionLE >> 24) & 0xFF)
        if (version & 0x100) {
            // AuxPoW version bit set but getblockheader returned no extra bytes
            // (Dogecoin Core 1.14). Parse the AuxPoW size from the block hex directly.
            const blockBuf = Buffer.from(blockHex, 'hex')
            const afterAuxPow = skipAuxPow(blockBuf, 80)
            return blockHex.substring(0, 160) + blockHex.substring(afterAuxPow * 2)
        }
    }
    return blockHex
}

module.exports = { encodeVarintHex, readVarint, skipAuxPow, stripAuxPowFromBlockHex }
