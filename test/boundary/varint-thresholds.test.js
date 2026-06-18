'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// ─── Boundary: varint size-class thresholds + uint64 verifuint limit ──────────
//
// The existing unit/bufferutils suite round-trips a single-byte varint and
// decodes one 3-byte (0xFD) value, and round-trips uint64 up to MAX_SAFE_INTEGER.
// What it does NOT pin are the *transitions* between Compact-Size classes,
// exactly the boundaries where an off-by-one in length math silently mis-frames a
// transaction. varint is encoded as: n < 0xFD → 1 byte; n ≤ 0xFFFF → 0xFD + 2
// bytes; n ≤ 0xFFFFFFFF → 0xFE + 4 bytes; else 0xFF + 8 bytes. We exercise the
// last value of each class and the first value of the next, in both directions
// (write→read and raw-byte inspection), plus the verifuint upper bound that
// guards writeUInt64LE/readUInt64LE against silent precision loss past 2^53.

const { expect } = require('chai');
const varuint = require('varuint-bitcoin');
// src/bufferutils.js is a Docker-only override of bitcoinjs-lib/src/bufferutils
// (its require('./types') only resolves inside the lib's src/). The code that
// runs locally (XChainBlockDecoder's BufferReader) loads the installed lib
// copy, so that is the real, exercised path we pin here (same API). See
// unit/bufferutils.test.js for the resolver shim that also covers the patch.
const {
  BufferWriter,
  BufferReader,
  writeUInt64LE,
  readUInt64LE,
} = require('bitcoinjs-lib/src/bufferutils');

// Round-trip a varint through the project's own BufferWriter/BufferReader,
// sizing the buffer to the EXACT encoded length so BufferWriter.end()'s
// fully-written assertion also guards the encoder's reported byte count.
function roundTripVarInt(n) {
  const len = varuint.encodingLength(n);
  const w = BufferWriter.withCapacity(len);
  w.writeVarInt(n);
  const buf = w.end(); // throws unless offset === capacity
  const r = new BufferReader(buf);
  const decoded = r.readVarInt();
  return { buf, len, decoded, consumed: r.offset };
}

describe('Boundary: varint size-class thresholds', function () {

  // [value, expectedByteLength, expectedLeadByte]
  // Lead byte is the Compact-Size discriminator (or the value itself when < 0xFD).
  const cases = [
    ['zero', 0, 1, 0x00],
    ['one below 1-byte ceiling (0xFC)', 0xFC, 1, 0xFC],
    ['first 0xFD class value (0xFD)', 0xFD, 3, 0xFD],
    ['16-bit ceiling (0xFFFF)', 0xFFFF, 3, 0xFD],
    ['first 0xFE class value (0x10000)', 0x10000, 5, 0xFE],
    ['32-bit ceiling (0xFFFFFFFF)', 0xFFFFFFFF, 5, 0xFE],
    ['first 0xFF class value (0x100000000)', 0x100000000, 9, 0xFF],
  ];

  cases.forEach(([label, value, expLen, expLead]) => {
    it(`encodes ${label} as ${expLen} byte(s) and round-trips exactly`, function () {
      const { buf, len, decoded, consumed } = roundTripVarInt(value);
      expect(len, 'encodingLength').to.equal(expLen);
      expect(buf.length, 'buffer length').to.equal(expLen);
      expect(buf[0], 'lead byte').to.equal(expLead);
      expect(decoded, 'decoded value').to.equal(value);
      expect(consumed, 'bytes consumed on read').to.equal(expLen);
    });
  });

  it('the class boundary is +1, not +/-1 fuzzy: 0xFC stays 1 byte, 0xFD jumps to 3', function () {
    expect(varuint.encodingLength(0xFC)).to.equal(1);
    expect(varuint.encodingLength(0xFD)).to.equal(3);
  });

  it('the 16→32-bit boundary is exact: 0xFFFF stays 3 bytes, 0x10000 jumps to 5', function () {
    expect(varuint.encodingLength(0xFFFF)).to.equal(3);
    expect(varuint.encodingLength(0x10000)).to.equal(5);
  });

  it('the 32→64-bit boundary is exact: 0xFFFFFFFF stays 5 bytes, 0x100000000 jumps to 9', function () {
    expect(varuint.encodingLength(0xFFFFFFFF)).to.equal(5);
    expect(varuint.encodingLength(0x100000000)).to.equal(9);
  });
});

describe('Boundary: writeUInt64LE / readUInt64LE verifuint limit', function () {
  // verifuint guards against values JS can't represent exactly as a Number.
  // The cap is 0x001fffffffffffff === 2**53 - 1 === Number.MAX_SAFE_INTEGER.
  const MAX = Number.MAX_SAFE_INTEGER; // 2**53 - 1

  it('round-trips exactly at the 2**53-1 ceiling', function () {
    const buf = Buffer.alloc(8);
    writeUInt64LE(buf, MAX, 0);
    expect(readUInt64LE(buf, 0)).to.equal(MAX);
  });

  it('rejects 2**53 (one past the safe-integer ceiling) on write', function () {
    const buf = Buffer.alloc(8);
    expect(() => writeUInt64LE(buf, MAX + 1, 0)).to.throw(/out of range/);
  });

  it('rejects a fractional value rather than truncating it', function () {
    const buf = Buffer.alloc(8);
    expect(() => writeUInt64LE(buf, 1.5, 0)).to.throw(/fractional/);
  });

  it('rejects a negative value rather than wrapping it', function () {
    const buf = Buffer.alloc(8);
    expect(() => writeUInt64LE(buf, -1, 0)).to.throw(/negative/);
  });

  it('reading a stored 2**53 (above the ceiling) is rejected, not silently rounded', function () {
    // Hand-encode 2**53 little-endian and confirm the reader's verifuint trips
    // rather than returning a lossy Number.
    const buf = Buffer.alloc(8);
    buf.writeUInt32LE(0x00000000, 0);
    buf.writeUInt32LE(0x00200000, 4); // high dword = 2**53 / 2**32
    expect(() => readUInt64LE(buf, 0)).to.throw(/out of range/);
  });
});
