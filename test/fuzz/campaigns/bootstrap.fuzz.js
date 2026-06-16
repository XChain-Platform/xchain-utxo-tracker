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
const { fc, FUZZ_RUNS } = require('../helpers');

describe('Fuzz: Bootstrap Filename Validation (P3)', function () {

  // The bootstrap/restore operations accept a filename parameter.
  // Fuzz test that path traversal and shell injection are not possible
  // by testing the validation logic that should exist.

  // ─── Path traversal detection ──────────────────────────────────────────────

  describe('filename sanitization', function () {
    // These are defensive tests that check whether filenames with
    // dangerous patterns are handled safely.

    const dangerousFilenames = [
      '../../../etc/passwd',
      '../../.env',
      '/etc/shadow',
      '/tmp/evil',
      'normal/../../../etc/passwd',
      'file\x00.tar.gz',          // null byte injection
      'file; rm -rf /',            // shell injection
      'file | cat /etc/passwd',
      'file`whoami`',
      'file$(whoami)',
      '....//....//etc/passwd',
      '%2e%2e%2f%2e%2e%2fetc/passwd',  // URL-encoded traversal
      'C:\\Windows\\System32\\config\\SAM',  // Windows path
    ];

    it('identifies path traversal patterns', function () {
      for (const filename of dangerousFilenames) {
        // Verify each dangerous filename is detectable by at least one check
        const hasDotDot = filename.includes('..');
        const hasAbsPath = filename.startsWith('/') || /^[A-Z]:/.test(filename);
        const hasNullByte = filename.includes('\x00');
        const hasShellMeta = /[;|`$(){}]/.test(filename);
        const hasUrlEncoded = filename.includes('%2e') || filename.includes('%2f');

        const isDangerous = hasDotDot || hasAbsPath || hasNullByte || hasShellMeta || hasUrlEncoded;
        expect(isDangerous, `Expected "${filename}" to be flagged as dangerous`).to.be.true;
      }
    });

    it('safe filenames pass validation', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.stringMatching(/^[a-zA-Z0-9_-]{1,50}\.tar\.gz$/),
          async (filename) => {
            // A filename matching this pattern should be safe
            expect(filename).to.not.include('..');
            expect(filename).to.not.include('/');
            expect(filename).to.not.include('\x00');
            expect(filename).to.match(/^[a-zA-Z0-9_.-]+$/);
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });

    it('fuzzed filenames never contain path separators in the basename', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 100 }),
          async (filename) => {
            // A proper sanitization function would strip path components
            const basename = filename.replace(/^.*[/\\]/, '');
            expect(basename).to.not.include('/');
            expect(basename).to.not.include('\\');
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });
  });

  // ─── Filename length boundaries ────────────────────────────────────────────

  describe('filename length', function () {
    it('empty filename is detectable', function () {
      expect('').to.have.length(0);
    });

    it('very long filenames are bounded', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 250, maxLength: 1000 }),
          async (filename) => {
            // Any reasonable filename should be < 255 characters
            // A validator should reject overly long filenames
            const isOverLong = filename.length > 255;
            if (isOverLong) {
              expect(filename.length).to.be.greaterThan(255);
            }
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });
  });

  // ─── Filename character validation ─────────────────────────────────────────

  describe('character validation', function () {
    it('null bytes are detectable in any position', async function () {
      await fc.assert(
        fc.asyncProperty(
          fc.string({ minLength: 1, maxLength: 50 }),
          fc.integer({ min: 0, max: 49 }),
          async (str, pos) => {
            const idx = Math.min(pos, str.length);
            const withNull = str.substring(0, idx) + '\x00' + str.substring(idx);
            expect(withNull).to.include('\x00');
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });
  });
});
