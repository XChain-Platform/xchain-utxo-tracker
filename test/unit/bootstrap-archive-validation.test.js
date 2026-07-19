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
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createHash } = require('crypto');

const { validateBootstrapArchiveOrThrow } = require('../../src/api.js');

function sha256Hex(buf) {
    return createHash('sha256').update(buf).digest('hex');
}

// Build a single-layer archive: a gzip tar whose members are plain store files
// (CURRENT, MANIFEST-...) so isWrapperArchive does NOT flag it.
function buildSingleLayerArchive(dir) {
    const storeDir = path.join(dir, 'store');
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(path.join(storeDir, 'CURRENT'), 'MANIFEST-000001\n');
    fs.writeFileSync(path.join(storeDir, 'MANIFEST-000001'), 'x'.repeat(64));
    const archive = path.join(dir, 'single.tar.gz');
    const r = spawnSync('tar', ['-czf', archive, '-C', storeDir, '.']);
    if (r.status !== 0) throw new Error('tar failed building single-layer fixture');
    return archive;
}

// Build a two-layer wrapper archive: outer gzip tar containing data.tar.gz +
// data.sha256, mirroring xchain-node's BootstrapService output.
function buildWrapperArchive(dir, { corruptChecksum = false } = {}) {
    const inner = path.join(dir, 'data.tar.gz');
    // The inner payload need only be a real gzip tar for later pipeline stages; here we
    // only exercise validation/unwrap, so any bytes with a matching checksum suffice.
    fs.writeFileSync(inner, Buffer.from('inner-payload-bytes'));
    const digest = corruptChecksum ? '0'.repeat(64) : sha256Hex(fs.readFileSync(inner));
    fs.writeFileSync(path.join(dir, 'data.sha256'), `${digest}  data.tar.gz\n`);
    const archive = path.join(dir, 'wrapper.tar.gz');
    const r = spawnSync('tar', ['-czf', archive, '-C', dir, 'data.tar.gz', 'data.sha256']);
    if (r.status !== 0) throw new Error('tar failed building wrapper fixture');
    return archive;
}

describe('validateBootstrapArchiveOrThrow', function () {
    let tmp;
    beforeEach(function () {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-bootstrap-test-'));
        delete process.env.BOOTSTRAP_RESTORE_ALLOW_UNVERIFIED;
    });
    afterEach(function () {
        delete process.env.BOOTSTRAP_RESTORE_ALLOW_UNVERIFIED;
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    });

    // Finding #2725: missing sidecar fails closed unless the operator opts out.
    describe('single-layer sidecar gating (#2725)', function () {
        it('(a) missing sidecar + no env opt-out throws', async function () {
            const archive = buildSingleLayerArchive(tmp);
            let threw = false;
            try { await validateBootstrapArchiveOrThrow(archive); }
            catch (e) { threw = true; expect(e.message).to.match(/no checksum sidecar/); }
            expect(threw, 'expected a throw on missing sidecar').to.equal(true);
        });

        it('(b) missing sidecar + env opt-out set proceeds', async function () {
            const archive = buildSingleLayerArchive(tmp);
            process.env.BOOTSTRAP_RESTORE_ALLOW_UNVERIFIED = '1';
            const res = await validateBootstrapArchiveOrThrow(archive);
            expect(res.effectiveSource).to.equal(archive);
            expect(res.tmpDir).to.equal(null);
        });

        it('(c) present valid sidecar verifies and proceeds', async function () {
            const archive = buildSingleLayerArchive(tmp);
            const digest = sha256Hex(fs.readFileSync(archive));
            fs.writeFileSync(archive + '.sha256', `${digest}  single.tar.gz\n`);
            const res = await validateBootstrapArchiveOrThrow(archive);
            expect(res.effectiveSource).to.equal(archive);
        });

        it('present but mismatched sidecar throws', async function () {
            const archive = buildSingleLayerArchive(tmp);
            fs.writeFileSync(archive + '.sha256', `${'0'.repeat(64)}  single.tar.gz\n`);
            let threw = false;
            try { await validateBootstrapArchiveOrThrow(archive); }
            catch (e) { threw = true; expect(e.message).to.match(/sha256 mismatch/); }
            expect(threw).to.equal(true);
        });
    });

    // Finding #2726: wrapper archive is now unwrapped + checksum-verified, not refused.
    describe('wrapper unwrap (#2726)', function () {
        it('unwraps a valid wrapper and returns the inner data.tar.gz as effective source', async function () {
            const archive = buildWrapperArchive(tmp);
            const res = await validateBootstrapArchiveOrThrow(archive);
            expect(res.effectiveSource).to.match(/data\.tar\.gz$/);
            expect(fs.existsSync(res.effectiveSource)).to.equal(true);
            expect(res.tmpDir).to.be.a('string');
            // Caller owns cleanup; simulate it here.
            fs.rmSync(res.tmpDir, { recursive: true, force: true });
        });

        it('throws on a wrapper whose inner checksum does not match', async function () {
            const archive = buildWrapperArchive(tmp, { corruptChecksum: true });
            let threw = false;
            try { await validateBootstrapArchiveOrThrow(archive); }
            catch (e) { threw = true; expect(e.message).to.match(/sha256 mismatch/); }
            expect(threw, 'expected a throw on corrupt inner checksum').to.equal(true);
        });
    });
});
