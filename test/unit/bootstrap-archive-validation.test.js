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
const { createHash, generateKeyPairSync, sign: signAsymmetric } = require('crypto');

const { validateBootstrapArchiveOrThrow } = require('../../src/api.js');

function sha256Hex(buf) {
    return createHash('sha256').update(buf).digest('hex');
}

function sha256File(file) {
    return sha256Hex(fs.readFileSync(file));
}

// Tar a directory's contents into a gzip archive, the layout every fixture below
// builds on.
function tarDir(sourceDir, archive) {
    const r = spawnSync('tar', ['-czf', archive, '-C', sourceDir, '.']);
    if (r.status !== 0) throw new Error(`tar failed building fixture ${archive}`);
    return archive;
}

// Write a minimal but valid-looking classic-level store: `CURRENT` plus the
// `MANIFEST-<n>` it names, which is exactly what the content gate requires.
function writeStoreFiles(dir, { extraMembers = 0 } = {}) {
    fs.mkdirSync(dir, { recursive: true });
    // Members that sort BEFORE CURRENT, so a limit-10 member listing would miss the
    // real store files: the regression guard for the full-scan requirement.
    for (let i = 0; i < extraMembers; i++)
        fs.writeFileSync(path.join(dir, `00000${i}.ldb`), 'ldb');
    fs.writeFileSync(path.join(dir, 'CURRENT'), 'MANIFEST-000001\n');
    fs.writeFileSync(path.join(dir, 'MANIFEST-000001'), 'x'.repeat(64));
    return dir;
}

// Build a single-layer archive: a gzip tar whose members are plain store files
// (CURRENT, MANIFEST-...) so isWrapperArchive does NOT flag it.
function buildSingleLayerArchive(dir, opts = {}) {
    return tarDir(writeStoreFiles(path.join(dir, 'store'), opts), path.join(dir, 'single.tar.gz'));
}

// Build a single-layer archive that is correctly formed but holds no LevelDB store:
// this used to pass validation and then wipe /data.
function buildNonStoreArchive(dir) {
    const junkDir = path.join(dir, 'junk');
    fs.mkdirSync(junkDir, { recursive: true });
    fs.writeFileSync(path.join(junkDir, 'README.txt'), 'not a leveldb store');
    fs.writeFileSync(path.join(junkDir, 'payload.bin'), 'x'.repeat(128));
    return tarDir(junkDir, path.join(dir, 'nonstore.tar.gz'));
}

// Build a two-layer wrapper archive: outer gzip tar containing data.tar.gz +
// data.sha256, mirroring xchain-node's BootstrapService output. The inner payload is
// a real store archive so the content gate sees what the restore pipeline would.
function buildWrapperArchive(dir, { corruptChecksum = false, innerIsStore = true } = {}) {
    const stageDir = fs.mkdtempSync(path.join(dir, 'wrap-'));
    const inner = path.join(stageDir, 'data.tar.gz');
    const payloadDir = path.join(dir, innerIsStore ? 'wrapper-store' : 'wrapper-junk');
    if (innerIsStore) writeStoreFiles(payloadDir);
    else { fs.mkdirSync(payloadDir, { recursive: true }); fs.writeFileSync(path.join(payloadDir, 'README.txt'), 'no store here'); }
    tarDir(payloadDir, inner);
    const digest = corruptChecksum ? '0'.repeat(64) : sha256File(inner);
    fs.writeFileSync(path.join(stageDir, 'data.sha256'), `${digest}  data.tar.gz\n`);
    const archive = path.join(dir, 'wrapper.tar.gz');
    const r = spawnSync('tar', ['-czf', archive, '-C', stageDir, 'data.tar.gz', 'data.sha256']);
    if (r.status !== 0) throw new Error('tar failed building wrapper fixture');
    return archive;
}

// Pin a throwaway ed25519 key as the trust anchor and sign an archive the way
// xchain-node's publisher does (`v1 ed25519 <base64>` over the raw sha256 digest).
function pinTestSigningKey(dir) {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pubPath = path.join(dir, 'test_pubkey.pem');
    fs.writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }));
    process.env.UTXO_TRACKER_BOOTSTRAP_PUBKEY = pubPath;
    return { privateKey, pubPath };
}

function writeDetachedSig(archive, privateKey) {
    const sig = signAsymmetric(null, Buffer.from(sha256File(archive), 'hex'), privateKey);
    fs.writeFileSync(archive + '.sig', `v1 ed25519 ${sig.toString('base64')}\n`);
    return archive + '.sig';
}

describe('validateBootstrapArchiveOrThrow', function () {
    let tmp;
    beforeEach(function () {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-bootstrap-test-'));
        delete process.env.BOOTSTRAP_RESTORE_ALLOW_UNVERIFIED;
        delete process.env.UTXO_TRACKER_BOOTSTRAP_PUBKEY;
        // The integrity and layout suites below predate the provenance gate and
        // exercise the checksum layer on unsigned fixtures, so they take the same
        // unsigned opt-out an operator restoring a local getbootstrap snapshot uses.
        // The provenance suite clears it and asserts the fail-closed default itself.
        process.env.BOOTSTRAP_RESTORE_ALLOW_UNSIGNED = '1';
    });
    afterEach(function () {
        delete process.env.BOOTSTRAP_RESTORE_ALLOW_UNVERIFIED;
        delete process.env.BOOTSTRAP_RESTORE_ALLOW_UNSIGNED;
        delete process.env.UTXO_TRACKER_BOOTSTRAP_PUBKEY;
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    });

    // Missing sidecar fails closed unless the operator opts out.
    describe('single-layer sidecar gating', function () {
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

    // A wrapper archive is unwrapped + checksum-verified, not refused.
    describe('wrapper unwrap', function () {
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

    // The archive's own checksums travel with it, so provenance comes
    // from the detached signature checked against the repo-pinned key, fail-closed.
    describe('detached signature provenance gating', function () {
        beforeEach(function () { delete process.env.BOOTSTRAP_RESTORE_ALLOW_UNSIGNED; });

        it('a self-consistent single-layer archive with no .sig is refused by default', async function () {
            // A key IS pinned here, deliberately: what this case is about is the
            // MISSING SIGNATURE, and the refusal branch emits a different message
            // when no key is pinned at all. Without this the case passed only where
            // an untracked src/config/bootstrap_signing_pubkey.pem happened to sit on
            // disk, and failed on every clean checkout (measured on the CI venue
            // 2026-08-12, reproduced locally by hiding that file).
            pinTestSigningKey(tmp);
            const archive = buildSingleLayerArchive(tmp);
            fs.writeFileSync(archive + '.sha256', `${sha256File(archive)}  single.tar.gz\n`);
            let threw = false;
            try { await validateBootstrapArchiveOrThrow(archive); }
            catch (e) { threw = true; expect(e.message).to.match(/no signature file found/); }
            expect(threw, 'expected a fail-closed refusal on a missing .sig').to.equal(true);
        });

        it('a self-consistent WRAPPER archive with no .sig is refused by default', async function () {
            // Same reason as the single-layer case above: pin a key so the branch
            // under test is the missing .sig, not the missing key.
            pinTestSigningKey(tmp);
            const archive = buildWrapperArchive(tmp);
            let threw = false;
            try { await validateBootstrapArchiveOrThrow(archive); }
            catch (e) { threw = true; expect(e.message).to.match(/no signature file found/); }
            expect(threw, 'expected the wrapper branch to be gated too').to.equal(true);
        });

        it('an attacker-authored archive signed by the WRONG key is refused', async function () {
            const archive = buildWrapperArchive(tmp);
            const { privateKey } = generateKeyPairSync('ed25519');   // not the pinned key
            pinTestSigningKey(tmp);
            writeDetachedSig(archive, privateKey);
            let threw = false;
            try { await validateBootstrapArchiveOrThrow(archive); }
            catch (e) { threw = true; expect(e.message).to.match(/does not verify against the pinned/); }
            expect(threw, 'expected a refusal on a foreign signing key').to.equal(true);
        });

        it('a tampered archive whose .sig covers the ORIGINAL bytes is refused', async function () {
            const archive = buildWrapperArchive(tmp);
            const { privateKey } = pinTestSigningKey(tmp);
            writeDetachedSig(archive, privateKey);
            fs.appendFileSync(archive, 'tampered');
            let threw = false;
            try { await validateBootstrapArchiveOrThrow(archive); }
            catch (e) { threw = true; expect(e.message).to.match(/does not verify against the pinned/); }
            expect(threw, 'expected a refusal once the signed bytes changed').to.equal(true);
        });

        it('a malformed .sig is refused rather than skipped', async function () {
            const archive = buildWrapperArchive(tmp);
            pinTestSigningKey(tmp);
            fs.writeFileSync(archive + '.sig', 'not-a-signature\n');
            let threw = false;
            try { await validateBootstrapArchiveOrThrow(archive); }
            catch (e) { threw = true; expect(e.message).to.match(/is malformed/); }
            expect(threw, 'expected a malformed signature to fail closed').to.equal(true);
        });

        it('a correctly signed wrapper archive passes and is unwrapped', async function () {
            const archive = buildWrapperArchive(tmp);
            const { privateKey } = pinTestSigningKey(tmp);
            writeDetachedSig(archive, privateKey);
            const res = await validateBootstrapArchiveOrThrow(archive);
            expect(res.effectiveSource).to.match(/data\.tar\.gz$/);
            fs.rmSync(res.tmpDir, { recursive: true, force: true });
        });

        it('the unsigned opt-out lets a local getbootstrap snapshot round-trip', async function () {
            const archive = buildSingleLayerArchive(tmp);
            fs.writeFileSync(archive + '.sha256', `${sha256File(archive)}  single.tar.gz\n`);
            process.env.BOOTSTRAP_RESTORE_ALLOW_UNSIGNED = '1';
            const res = await validateBootstrapArchiveOrThrow(archive);
            expect(res.effectiveSource).to.equal(archive);
        });
    });

    // A checksum says "this is the published archive", never "this is a
    // LevelDB store". Without a content gate the wipe still fires and the tracker
    // reopens onto an empty DB.
    describe('LevelDB content gating', function () {
        it('refuses a correctly-checksummed single-layer archive holding no store', async function () {
            const archive = buildNonStoreArchive(tmp);
            fs.writeFileSync(archive + '.sha256', `${sha256File(archive)}  nonstore.tar.gz\n`);
            let threw = false;
            try { await validateBootstrapArchiveOrThrow(archive); }
            catch (e) { threw = true; expect(e.message).to.match(/does not contain a LevelDB store/); }
            expect(threw, 'expected a refusal before the destructive wipe').to.equal(true);
        });

        it('refuses a wrapper whose verified inner payload holds no store', async function () {
            const archive = buildWrapperArchive(tmp, { innerIsStore: false });
            let threw = false;
            try { await validateBootstrapArchiveOrThrow(archive); }
            catch (e) { threw = true; expect(e.message).to.match(/does not contain a LevelDB store/); }
            expect(threw, 'expected the unwrapped inner archive to be gated too').to.equal(true);
        });

        it('accepts a store whose CURRENT/MANIFEST sort past the first ten members', async function () {
            // The limit-10 listing used for wrapper detection would not see them, so this
            // pins the full-member scan rather than a reused short list.
            const archive = buildSingleLayerArchive(tmp, { extraMembers: 9 });
            fs.writeFileSync(archive + '.sha256', `${sha256File(archive)}  single.tar.gz\n`);
            const res = await validateBootstrapArchiveOrThrow(archive);
            expect(res.effectiveSource).to.equal(archive);
        });
    });
});
