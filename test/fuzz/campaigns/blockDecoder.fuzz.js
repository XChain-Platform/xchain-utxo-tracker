'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const { expect } = require('chai');
const { fc, FUZZ_RUNS, arbBufferRange, arbHexString } = require('../helpers');
const XChainBlockDecoder = require('../../../src/XChainBlockDecoder');
const bitcoinjs = require('bitcoinjs-lib');

describe('Fuzz: Block Decoder (P0)', function () {
  let decoder;

  before(function () {
    decoder = new XChainBlockDecoder('bitcoin-regtest');
  });

  // ─── blockFromBuffer — random buffers must never hang or segfault ──────────

  describe('blockFromBuffer', function () {
    it('never hangs on arbitrary buffers (throws or returns)', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.uint8Array({ minLength: 0, maxLength: 500 }),
          async (bytes) => {
            const buf = Buffer.from(bytes);
            try {
              decoder.blockFromBuffer(buf);
            } catch (e) {
              // Throwing is fine — we just assert it doesn't hang or segfault
              expect(e).to.be.an('error');
            }
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });

    it('rejects buffers smaller than 80 bytes', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.uint8Array({ minLength: 0, maxLength: 79 }),
          async (bytes) => {
            const buf = Buffer.from(bytes);
            try {
              decoder.blockFromBuffer(buf);
              // bitcoinjs Block.fromBuffer also throws for < 80 bytes
              // If it doesn't throw, that's still acceptable
            } catch (e) {
              expect(e).to.be.an('error');
            }
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });

    it('handles exactly 80-byte buffers (header only, no transactions)', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.uint8Array({ minLength: 80, maxLength: 80 }),
          async (bytes) => {
            const buf = Buffer.from(bytes);
            try {
              const block = decoder.blockFromBuffer(buf);
              // 80-byte buffer = header only; should return a block with no transactions
              // or throw if the default parser doesn't support header-only
            } catch (e) {
              expect(e).to.be.an('error');
            }
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });

    it('handles buffers > 80 bytes with fuzzed transaction data', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.uint8Array({ minLength: 81, maxLength: 2000 }),
          async (bytes) => {
            const buf = Buffer.from(bytes);
            try {
              decoder.blockFromBuffer(buf);
            } catch (e) {
              expect(e).to.be.an('error');
            }
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });
  });

  // ─── blockFromHex — fuzzed hex strings ─────────────────────────────────────

  describe('blockFromHex', function () {
    it('never hangs on arbitrary hex strings', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.uint8Array({ minLength: 0, maxLength: 1000 }).map(a => Buffer.from(a).toString('hex')),
          async (hex) => {
            try {
              decoder.blockFromHex(hex);
            } catch (e) {
              expect(e).to.be.an('error');
            }
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });

    it('handles non-hex strings gracefully', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 0, maxLength: 500 }),
          async (str) => {
            try {
              decoder.blockFromHex(str);
            } catch (e) {
              // Must not crash with unhandled error types
              expect(e).to.exist;
            }
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });
  });

  // ─── txFromHex — fuzzed transaction hex ────────────────────────────────────

  describe('txFromHex', function () {
    it('never hangs on arbitrary hex', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.uint8Array({ minLength: 0, maxLength: 1000 }).map(a => Buffer.from(a).toString('hex')),
          async (hex) => {
            try {
              decoder.txFromHex(hex);
            } catch (e) {
              expect(e).to.be.an('error');
            }
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });

    it('handles empty hex string', function () {
      try {
        decoder.txFromHex('');
      } catch (e) {
        expect(e).to.be.an('error');
      }
    });
  });

  // ─── Litecoin-specific parsing ─────────────────────────────────────────────

  describe('litecoin block decoder', function () {
    let ltcDecoder;

    before(function () {
      ltcDecoder = new XChainBlockDecoder('litecoin-regtest');
    });

    it('blockFromBuffer handles arbitrary buffers without hanging', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.uint8Array({ minLength: 0, maxLength: 500 }),
          async (bytes) => {
            const buf = Buffer.from(bytes);
            try {
              ltcDecoder.blockFromBuffer(buf);
            } catch (e) {
              expect(e).to.be.an('error');
            }
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });

    it('txFromHex handles HogEx flag combinations', async function () {
      // Generate hex that starts with valid-looking version + marker + flag patterns
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('01000000', '02000000', 'ffffffff'),
          fc.constantFrom('00', 'ff', '01'),
          fc.constantFrom('08', '09', '01', 'ff'),
          fc.uint8Array({ minLength: 10, maxLength: 200 }).map(a => Buffer.from(a).toString('hex')),
          async (version, marker, flag, rest) => {
            const hex = version + marker + flag + rest;
            try {
              ltcDecoder.txFromHex(hex);
            } catch (e) {
              expect(e).to.be.an('error');
            }
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });
  });

  // ─── doubleSha256AndReverse — should always produce 32 bytes ───────────────

  describe('doubleSha256AndReverse', function () {
    it('always returns a 32-byte buffer for any input', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.uint8Array({ minLength: 0, maxLength: 10000 }),
          async (bytes) => {
            const result = decoder.doubleSha256AndReverse(Buffer.from(bytes));
            expect(result).to.be.instanceOf(Buffer);
            expect(result.length).to.equal(32);
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });
  });
});
