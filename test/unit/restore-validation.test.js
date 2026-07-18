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
 *********************************************************************/

'use strict';

const { expect } = require('chai');
const { isWrapperArchive, parseSha256Sidecar } = require('../../src/restore-validation.js');

describe('restore-validation', function () {

    describe('isWrapperArchive', function () {
        it('flags the BootstrapService wrapper member set', function () {
            expect(isWrapperArchive(['data.tar.gz', 'data.sha256'])).to.equal(true);
        });
        it('flags a wrapper member even behind a ./ prefix', function () {
            expect(isWrapperArchive(['./data.tar.gz'])).to.equal(true);
        });
        it('flags on either wrapper member alone', function () {
            expect(isWrapperArchive(['data.sha256'])).to.equal(true);
        });
        it('does NOT flag a genuine single-layer LevelDB store', function () {
            // A classic-level store never contains data.tar.gz / data.sha256.
            expect(isWrapperArchive(['CURRENT', 'MANIFEST-000001', '000005.ldb', '000004.log', 'LOCK'])).to.equal(false);
        });
        it('is false for an empty or non-array input', function () {
            expect(isWrapperArchive([])).to.equal(false);
            expect(isWrapperArchive(null)).to.equal(false);
            expect(isWrapperArchive(undefined)).to.equal(false);
        });
    });

    describe('parseSha256Sidecar', function () {
        const HEX = 'a'.repeat(64);
        it('reads a bare digest', function () {
            expect(parseSha256Sidecar(HEX)).to.equal(HEX);
        });
        it('reads the sha256sum "<hex>  <file>" format', function () {
            expect(parseSha256Sidecar(`${HEX}  latest.tgz\n`)).to.equal(HEX);
        });
        it('lowercases the digest for a case-insensitive compare', function () {
            expect(parseSha256Sidecar('A'.repeat(64))).to.equal('a'.repeat(64));
        });
        it('returns null when no 64-hex digest is present', function () {
            expect(parseSha256Sidecar('not a checksum')).to.equal(null);
            expect(parseSha256Sidecar('deadbeef')).to.equal(null); // too short
            expect(parseSha256Sidecar('')).to.equal(null);
            expect(parseSha256Sidecar(null)).to.equal(null);
        });
    });
});
