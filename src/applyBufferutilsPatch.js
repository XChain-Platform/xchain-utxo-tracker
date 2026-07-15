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
 * In-process application of the BigInt-safe bufferutils patch.
 *
 * Stock bitcoinjs-lib reads a transaction output value with a Number-based
 * 64-bit reader that throws 'RangeError: value out of range' above 2^53-1,
 * a ceiling Dogecoin mainnet exceeds (>~90.07M DOGE in one output); the
 * first such output wedges block decode permanently. The fix used to live
 * only in the Dockerfile COPY of src/bufferutils.js over node_modules, so
 * any non-Docker run (or a node_modules refresh inside a container)
 * silently reverted to the stock reader. Requiring this module rewrites
 * the loaded bitcoinjs-lib bufferutils module in place with the same
 * behavior as the patched file, making every runtime safe regardless of
 * whether the Dockerfile COPY happened.
 *
 * src/bufferutils.js itself cannot be required here: its require('./types')
 * only resolves once the file sits inside bitcoinjs-lib/src/. The overrides
 * below mirror that file exactly; change them together.
 *
 * All bitcoinjs-lib consumers (block.js, transaction.js, psbt.js) hold the
 * module's exports object and its class prototypes rather than destructured
 * copies, so mutating them here retrofits every current and future caller.
 *
 ********************************************************************/

const bufferutils = require('bitcoinjs-lib/src/bufferutils');

// Probe with a 2^53 uint64, one past the stock reader's ceiling: the stock
// reader throws, the BigInt-safe reader (this patch, or the Dockerfile COPY
// already in place) returns it. Idempotence guard, not just an optimization.
function bigIntReaderActive(bu) {
    try {
        new bu.BufferReader(Buffer.from([0, 0, 0, 0, 0, 0, 0x20, 0])).readUInt64();
        return true;
    } catch (_) {
        return false;
    }
}

if (!bigIntReaderActive(bufferutils)) {
    // BigInt-tolerant bounds check, mirroring verifuint in src/bufferutils.js.
    const verifuint = function (value, max) {
        if (typeof value !== 'number' && typeof value !== 'bigint')
            throw new Error('cannot write a non-number as a number');
        if (value < 0 && value < BigInt(0))
            throw new Error('specified a negative value for writing an unsigned value');
        if (value > max && value > BigInt(max))
            throw new Error('RangeError: value out of range');
        if (Math.floor(Number(value)) !== Number(value))
            throw new Error('value has a fractional component');
    };

    bufferutils.readUInt64LE = function readUInt64LE(buffer, offset) {
        const a = buffer.readUInt32LE(offset);
        let b = buffer.readUInt32LE(offset + 4);
        b *= 0x100000000;
        verifuint(b + a, 0x001fffffffffffff);
        return b + a;
    };

    bufferutils.writeUInt64LE = function writeUInt64LE(buffer, value, offset) {
        verifuint(value, 0x001fffffffffffff);
        buffer.writeInt32LE(value & -1, offset);
        buffer.writeUInt32LE(Math.floor(value / 0x100000000), offset + 4);
        return offset + 8;
    };

    bufferutils.BufferReader.prototype.readUInt64 = function readUInt64() {
        // Bitcoin wire tx output value is an UNSIGNED 64-bit LE integer; the signed
        // reader would decode a value >= 2^63 as a negative BigInt instead of a large
        // positive one. Use the unsigned reader (matches LevelUpDb readBigUInt64BE).
        const result = this.buffer.readBigUInt64LE(this.offset);
        this.offset += 8;
        return result;
    };

    bufferutils.BufferWriter.prototype.writeUInt64 = function writeUInt64(value) {
        // Accept Number (bitcoinjs-lib serializes tx output values as Number) as
        // well as BigInt; unsigned write matches the unsigned reader above.
        this.offset = this.buffer.writeBigUInt64LE(BigInt(value), this.offset);
    };
}

module.exports = bufferutils;
