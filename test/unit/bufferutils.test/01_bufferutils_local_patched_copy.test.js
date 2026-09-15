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

const { expect } = require('chai');

// The local bufferutils.js is the patched version that Docker copies over the
// installed bitcoinjs-lib copy. Its require('./types') resolves relative to
// bitcoinjs-lib/src/ which only exists there. To test the local file we
// intercept Module resolution so './types' resolves from the bitcoinjs-lib dir.
const Module = require('module');
const path = require('path');
const localBufPath = path.resolve(__dirname, '..', '..', '..', 'src', 'chain', 'bufferutils.js');
const bitcoinjsSrc = path.join(__dirname, '..', '..', '..', 'node_modules', 'bitcoinjs-lib', 'src');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (parent && parent.filename === localBufPath && request.startsWith('./')) {
    return origResolve.call(this, path.join(bitcoinjsSrc, request), parent, ...rest);
  }
  return origResolve.call(this, request, parent, ...rest);
};
const localBufferutils = require('../../../src/chain/bufferutils');
Module._resolveFilename = origResolve;

// Local bufferutils.js: the patched file that lives in the repo root.
// These tests ensure mutations to the local file are detected by Stryker.
describe('bufferutils (local patched copy)', function () {

  describe('readUInt64LE / writeUInt64LE', function () {
    it('round-trips zero', function () {
      const buf = Buffer.alloc(8);
      localBufferutils.writeUInt64LE(buf, 0, 0);
      expect(localBufferutils.readUInt64LE(buf, 0)).to.equal(0);
    });
    it('round-trips a typical satoshi value', function () {
      const val = 50_000_000;
      const buf = Buffer.alloc(8);
      localBufferutils.writeUInt64LE(buf, val, 0);
      expect(localBufferutils.readUInt64LE(buf, 0)).to.equal(val);
    });
    it('round-trips MAX_SAFE_INTEGER', function () {
      const val = Number.MAX_SAFE_INTEGER;
      const buf = Buffer.alloc(8);
      localBufferutils.writeUInt64LE(buf, val, 0);
      expect(localBufferutils.readUInt64LE(buf, 0)).to.equal(val);
    });
    it('writes in little-endian byte order', function () {
      const buf = Buffer.alloc(8);
      localBufferutils.writeUInt64LE(buf, 1, 0);
      expect(buf[0]).to.equal(1);
      expect(buf.slice(1).every(b => b === 0)).to.be.true;
    });
    it('throws for negative values', function () {
      const buf = Buffer.alloc(8);
      expect(() => localBufferutils.writeUInt64LE(buf, -1, 0)).to.throw();
    });
    it('supports a non-zero offset', function () {
      const buf = Buffer.alloc(16);
      const val = 12345678;
      localBufferutils.writeUInt64LE(buf, val, 8);
      expect(localBufferutils.readUInt64LE(buf, 8)).to.equal(val);
    });
  });

});

describe('bufferutils (local patched copy)', function () {

  describe('reverseBuffer', function () {
    it('reverses a multi-byte buffer in place', function () {
      const buf = Buffer.from([0x01, 0x02, 0x03, 0x04]);
      const result = localBufferutils.reverseBuffer(buf);
      expect(result).to.deep.equal(Buffer.from([0x04, 0x03, 0x02, 0x01]));
      expect(result).to.equal(buf);
    });
    it('handles single-byte buffer', function () {
      const buf = Buffer.from([0xAB]);
      localBufferutils.reverseBuffer(buf);
      expect(buf[0]).to.equal(0xAB);
    });
    it('handles empty buffer', function () {
      const buf = Buffer.alloc(0);
      const result = localBufferutils.reverseBuffer(buf);
      expect(result.length).to.equal(0);
    });
  });

});

describe('bufferutils (local patched copy)', function () {

  describe('cloneBuffer', function () {
    it('creates an independent copy', function () {
      const orig = Buffer.from([1, 2, 3]);
      const clone = localBufferutils.cloneBuffer(orig);
      expect(clone).to.deep.equal(orig);
      clone[0] = 99;
      expect(orig[0]).to.equal(1);
    });
  });

});

describe('bufferutils (local patched copy)', function () {

  describe('BufferWriter', function () {
    it('writes and ends at exact capacity', function () {
      const writer = localBufferutils.BufferWriter.withCapacity(1 + 4 + 4);
      writer.writeUInt8(0xFF);
      writer.writeUInt32(0x12345678);
      writer.writeInt32(-1);
      const buf = writer.end();
      expect(buf.length).to.equal(9);
      expect(buf.readUInt8(0)).to.equal(0xFF);
      expect(buf.readUInt32LE(1)).to.equal(0x12345678);
      expect(buf.readInt32LE(5)).to.equal(-1);
    });
    it('writeUInt64 writes a BigInt value', function () {
      const writer = localBufferutils.BufferWriter.withCapacity(8);
      writer.writeUInt64(BigInt(256));
      const buf = writer.end();
      expect(buf.readBigInt64LE(0)).to.equal(BigInt(256));
    });
    it('writeVarInt + writeVarSlice + writeVector encode length-prefixed data', function () {
      const a = Buffer.from([0xAA]);
      const b = Buffer.from([0xBB, 0xCC]);
      // 1 (varint count) + (1+1) + (1+2) = 6 bytes
      const writer = localBufferutils.BufferWriter.withCapacity(6);
      writer.writeVector([a, b]);
      const buf = writer.end();
      const reader = new localBufferutils.BufferReader(buf);
      expect(reader.readVarInt()).to.equal(2);          // count
      expect(reader.readVarSlice()).to.deep.equal(a);
      expect(reader.readVarSlice()).to.deep.equal(b);
    });
    it('writeSlice throws when writing past the buffer end', function () {
      const writer = new localBufferutils.BufferWriter(Buffer.alloc(2));
      expect(() => writer.writeSlice(Buffer.from([1, 2, 3]))).to.throw(/out of bounds/);
    });
    it('end() throws when the buffer is not fully written', function () {
      const writer = new localBufferutils.BufferWriter(Buffer.alloc(4));
      writer.writeUInt8(1);
      expect(() => writer.end()).to.throw(/buffer size/);
    });
  });

});

describe('bufferutils (local patched copy)', function () {

  describe('BufferReader', function () {
    it('reads UInt8 and advances offset', function () {
      const reader = new localBufferutils.BufferReader(Buffer.from([0xAB, 0xCD]));
      expect(reader.readUInt8()).to.equal(0xAB);
      expect(reader.offset).to.equal(1);
      expect(reader.readUInt8()).to.equal(0xCD);
    });
    it('reads Int32 and UInt32 in LE', function () {
      const buf = Buffer.alloc(8);
      buf.writeInt32LE(-42, 0);
      buf.writeUInt32LE(0xDEADBEEF, 4);
      const reader = new localBufferutils.BufferReader(buf);
      expect(reader.readInt32()).to.equal(-42);
      expect(reader.readUInt32()).to.equal(0xDEADBEEF);
    });
    it('reads UInt64 value', function () {
      const buf = Buffer.alloc(8);
      buf.writeUInt32LE(100000000, 0);
      buf.writeUInt32LE(0, 4);
      const reader = new localBufferutils.BufferReader(buf);
      const val = reader.readUInt64();
      expect(Number(val)).to.equal(100000000);
    });
    it('readSlice returns exact bytes and advances', function () {
      const reader = new localBufferutils.BufferReader(Buffer.from([1, 2, 3, 4, 5]));
      const slice = reader.readSlice(3);
      expect(slice).to.deep.equal(Buffer.from([1, 2, 3]));
      expect(reader.offset).to.equal(3);
    });
    it('readSlice throws when reading past the end', function () {
      const reader = new localBufferutils.BufferReader(Buffer.from([1, 2]));
      expect(() => reader.readSlice(5)).to.throw(/out of bounds/);
    });
    it('readVarInt decodes a single-byte and a 0xFD-prefixed value', function () {
      expect(new localBufferutils.BufferReader(Buffer.from([0x10])).readVarInt()).to.equal(16);
      // 0xFD marks a 2-byte little-endian value (300 = 0x012C)
      const r = new localBufferutils.BufferReader(Buffer.from([0xFD, 0x2C, 0x01]));
      expect(r.readVarInt()).to.equal(300);
      expect(r.offset).to.equal(3);
    });
    it('readVarSlice reads length-prefixed data', function () {
      const reader = new localBufferutils.BufferReader(Buffer.from([0x02, 0xAA, 0xBB]));
      expect(reader.readVarSlice()).to.deep.equal(Buffer.from([0xAA, 0xBB]));
    });
    it('readVector reads a count-prefixed list of var slices', function () {
      // count=2, then [0x01,0xAA], [0x02,0xBB,0xCC]
      const buf = Buffer.from([0x02, 0x01, 0xAA, 0x02, 0xBB, 0xCC]);
      const vec = new localBufferutils.BufferReader(buf).readVector();
      expect(vec).to.have.length(2);
      expect(vec[0]).to.deep.equal(Buffer.from([0xAA]));
      expect(vec[1]).to.deep.equal(Buffer.from([0xBB, 0xCC]));
    });
  });

});

describe('bufferutils (local patched copy)', function () {

  describe('BufferWriter / BufferReader round-trip', function () {
    it('round-trips a structure with integers and slices', function () {
      const writer = localBufferutils.BufferWriter.withCapacity(1 + 4 + 4 + 3);
      writer.writeUInt8(42);
      writer.writeUInt32(100000);
      writer.writeInt32(-500);
      writer.writeSlice(Buffer.from([0xDE, 0xAD, 0x00]));
      const buf = writer.end();

      const reader = new localBufferutils.BufferReader(buf);
      expect(reader.readUInt8()).to.equal(42);
      expect(reader.readUInt32()).to.equal(100000);
      expect(reader.readInt32()).to.equal(-500);
      const tail = reader.readSlice(3);
      expect(tail).to.deep.equal(Buffer.from([0xDE, 0xAD, 0x00]));
    });
  });

});
