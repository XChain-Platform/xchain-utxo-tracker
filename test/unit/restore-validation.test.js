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
const { isWrapperArchive, parseSha256Sidecar,
        hasRequiredLevelDbMembers, parseDetachedSignature } = require('../../src/restore-validation.js');

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

    describe('hasRequiredLevelDbMembers (#4368)', function () {
        it('accepts a real classic-level member set', function () {
            expect(hasRequiredLevelDbMembers(['CURRENT', 'MANIFEST-000001', '000005.ldb', '000004.log', 'LOCK']))
                .to.equal(true);
        });
        it('accepts the same members behind a ./ or directory prefix', function () {
            expect(hasRequiredLevelDbMembers(['./', './CURRENT', './MANIFEST-000007', './000005.ldb']))
                .to.equal(true);
            expect(hasRequiredLevelDbMembers(['store/CURRENT', 'store/MANIFEST-000007'])).to.equal(true);
        });
        it('rejects an archive of unrelated files', function () {
            expect(hasRequiredLevelDbMembers(['README.txt', 'payload.bin', 'etc/passwd'])).to.equal(false);
        });
        it('rejects a set missing CURRENT', function () {
            expect(hasRequiredLevelDbMembers(['MANIFEST-000001', '000005.ldb'])).to.equal(false);
        });
        it('rejects a set with no MANIFEST-<n>', function () {
            expect(hasRequiredLevelDbMembers(['CURRENT', '000005.ldb'])).to.equal(false);
            // A file merely starting with MANIFEST is not the numbered manifest.
            expect(hasRequiredLevelDbMembers(['CURRENT', 'MANIFEST-notes.txt'])).to.equal(false);
        });
        it('rejects the wrapper layout, which is not a store', function () {
            expect(hasRequiredLevelDbMembers(['data.tar.gz', 'data.sha256'])).to.equal(false);
        });
        it('is false for an empty or non-array input', function () {
            expect(hasRequiredLevelDbMembers([])).to.equal(false);
            expect(hasRequiredLevelDbMembers(null)).to.equal(false);
            expect(hasRequiredLevelDbMembers(undefined)).to.equal(false);
        });
    });

    describe('parseDetachedSignature (#4426)', function () {
        const B64 = Buffer.alloc(64, 7).toString('base64');
        it('reads the publisher\'s "v1 ed25519 <base64>" line', function () {
            const sig = parseDetachedSignature(`v1 ed25519 ${B64}\n`);
            expect(Buffer.isBuffer(sig)).to.equal(true);
            expect(sig.length).to.equal(64);
        });
        it('returns null on a wrong version or algorithm', function () {
            expect(parseDetachedSignature(`v2 ed25519 ${B64}`)).to.equal(null);
            expect(parseDetachedSignature(`v1 rsa ${B64}`)).to.equal(null);
        });
        it('returns null on a signature that is not 64 bytes', function () {
            expect(parseDetachedSignature('v1 ed25519 ' + Buffer.alloc(32).toString('base64'))).to.equal(null);
        });
        it('returns null on junk, empty, or non-string input', function () {
            expect(parseDetachedSignature('not-a-signature')).to.equal(null);
            expect(parseDetachedSignature('')).to.equal(null);
            expect(parseDetachedSignature(null)).to.equal(null);
        });
    });
});
