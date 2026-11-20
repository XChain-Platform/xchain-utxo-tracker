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
 * bitcoinjs-lib v7 compatibility for the tracker's unsigned value contract.
 *
 ********************************************************************/

const bufferutils = require('./apply_bufferutils_patch')

function asBufferView(bytes) {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

function readUnsigned64(bytes, offset) {
    return asBufferView(bytes).readBigUInt64LE(offset)
}

function writeUnsigned64(bytes, value, offset) {
    asBufferView(bytes).writeBigUInt64LE(BigInt(value), offset)
    return offset + 8
}

function unsignedReaderActive() {
    try {
        const reader = new bufferutils.BufferReader(Buffer.from('ffffffffffffffff', 'hex'))
        return reader.readInt64() === 18446744073709551615n
    } catch (_) {
        return false
    }
}

if (!unsignedReaderActive()) {
    bufferutils.BufferReader.prototype.readUInt64 = function readUInt64() {
        const result = readUnsigned64(this.buffer, this.offset)
        this.offset += 8
        return result
    }
    bufferutils.BufferReader.prototype.readInt64 =
        bufferutils.BufferReader.prototype.readUInt64
}

bufferutils.BufferWriter.prototype.writeUInt64 = function writeUInt64(value) {
    this.offset = writeUnsigned64(this.buffer, value, this.offset)
}
bufferutils.BufferWriter.prototype.writeInt64 =
    bufferutils.BufferWriter.prototype.writeUInt64

module.exports = bufferutils
