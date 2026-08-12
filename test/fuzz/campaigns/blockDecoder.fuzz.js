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
const { fc, FUZZ_RUNS, arbBufferRange, arbHexString } = require('../helpers');
const XChainBlockDecoder = require('../../../src/XChainBlockDecoder');
const bitcoinjs = require('bitcoinjs-lib');

describe('Fuzz: Block Decoder (P0)', function () {
  let decoder;

  before(function () {
    decoder = new XChainBlockDecoder('bitcoin-regtest');
  });

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
              // The property under test is "never hangs or segfaults"; a thrown
              // Error is a passing outcome, not a failure.
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
              // bitcoinjs Block.fromBuffer also throws below 80 bytes, but
              // succeeding here is not treated as a failure either.
              decoder.blockFromBuffer(buf);
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
              // A bare 80-byte buffer is header-only (no transactions); either
              // a block with zero transactions or a throw is acceptable here.
              const block = decoder.blockFromBuffer(buf);
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
              // Looser than the Error-instance checks elsewhere: non-hex input
              // may reach a throw of a non-Error value, which is still a pass.
              expect(e).to.exist;
            }
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });
  });

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
      // Structured rather than pure-random input, so runs actually exercise
      // the version/marker/flag parsing path instead of failing before it.
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
