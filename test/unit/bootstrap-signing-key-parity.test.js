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

// The bootstrap signing trust anchor is pinned TWICE, once per repo, and both
// pins verify fail-closed:
//
//   * this repo's src/config/bootstrap_signing_pubkey.pem, loaded by
//     loadBootstrapPublicKey() and enforced by verifyBootstrapProvenanceOrThrow()
//     BEFORE the destructive /data wipe;
//   * xchain-node's src/config/bootstrap_signing_pubkey.pem, the publisher side,
//     used by verifyBootstrapSignature().
//
// A rotation that updates one and not the other is an outage with no warning
// stage: every restore of a freshly published archive is refused with "detached
// signature ... does not verify against the pinned bootstrap signing key", the
// unsigned opt-out cannot bypass it (that opt-out covers an ABSENT signature, and
// this one is present and merely wrong), and each attempt lands in the pre-wipe
// branch of bootstrap-recovery.js, so the container retries against an archive
// that can never verify. Until now the only thing preventing that was a step in a
// rotation runbook that someone has to remember.
//
// Nothing else in either suite reads either committed pem: every provenance test
// substitutes a throwaway key through the env override, so the shipped anchor was
// never an assertion subject at all.
//
// Skips when xchain-node is not checked out beside this repo (a standalone
// deploy), matching blockDecoderTwinParity and coins-conformance; set
// XCHAIN_REQUIRE_SIBLINGS=1 in CI, with the sibling checked out or XCHAIN_NODE_DIR
// pointed at it, so a missing sibling hard-fails instead of passing by skip.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { createHash, createPublicKey } = require('crypto');

const REPO = path.join(__dirname, '..', '..');
const PIN_REL = path.join('src', 'config', 'bootstrap_signing_pubkey.pem');
const PIN = path.join(REPO, PIN_REL);

const NODE_DIR = process.env.XCHAIN_NODE_DIR || path.join(REPO, '..', 'xchain-node');
const SIBLING_PIN = path.join(NODE_DIR, PIN_REL);
const SIBLING_PRESENT = fs.existsSync(SIBLING_PIN);
const REQUIRE_SIBLINGS = process.env.XCHAIN_REQUIRE_SIBLINGS === '1';

// Compared as exported SPKI DER, not as file bytes: the two repos may legitimately
// differ in line ending or trailing newline, and that is not a rotation. The sha256
// of the raw bytes goes in the failure message instead, because that is the field
// the rotation runbook tells the operator to eyeball.
function der(pemPath) {
    return createPublicKey(fs.readFileSync(pemPath, 'utf8')).export({ type: 'spki', format: 'der' });
}

function sha256(pemPath) {
    return createHash('sha256').update(fs.readFileSync(pemPath)).digest('hex').slice(0, 16);
}

describe('bootstrap signing key: the shipped trust anchor @security', function () {

    it('is present and parses as an ed25519 public key', function () {
        expect(fs.existsSync(PIN), `no pinned bootstrap signing key at ${PIN}. Every restore then takes the `
            + 'no-key-pinned branch and is refused before the wipe unless the operator sets '
            + 'BOOTSTRAP_RESTORE_ALLOW_UNSIGNED=1, which drops provenance checking entirely').to.equal(true);
        const key = createPublicKey(fs.readFileSync(PIN, 'utf8'));
        expect(key.asymmetricKeyType, `${PIN} is not an ed25519 key, but the published signatures are `
            + '"v1 ed25519 <base64>"').to.equal('ed25519');
    });

    it('is committed, not merely present on this disk', function () {
        const r = spawnSync('git', ['ls-files', '--error-unmatch', PIN_REL], { cwd: REPO, encoding: 'utf8' });
        if (r.error || r.status === null) {
            this.skip();  // no git on this host; the assertion below needs a checkout
            return;
        }
        expect(r.status, `${PIN_REL} is not tracked by git. An untracked pin makes this whole file pass `
            + 'locally and fail on every clean checkout and container build, where the anchor is simply '
            + 'absent - which has happened here before').to.equal(0);
    });

    it('is the file the restore path actually loads', function () {
        // A guard on a file nothing reads is worth nothing, so tie the path this
        // test asserts on to the constant api.js resolves. Read as TEXT rather than
        // required: loading api.js pulls the whole service in for one string.
        const src = fs.readFileSync(path.join(REPO, 'src', 'api.js'), 'utf8');
        expect(src, 'src/api.js no longer pins config/bootstrap_signing_pubkey.pem, so this parity guard '
            + 'is watching a file the restore path does not load. Re-point it at the new constant rather '
            + 'than deleting the assertion').to.match(
            /DEFAULT_BOOTSTRAP_PUBKEY_PATH\s*=\s*path\.join\(__dirname,\s*'config',\s*'bootstrap_signing_pubkey\.pem'\)/);
    });

    it('is byte-for-byte the key xchain-node publishes with', function () {
        if (!SIBLING_PRESENT) {
            if (REQUIRE_SIBLINGS)
                throw new Error(`XCHAIN_REQUIRE_SIBLINGS=1 but the xchain-node pin was not found at ${SIBLING_PIN}. `
                    + 'This assertion is the only automated thing tying the two pinned bootstrap signing keys '
                    + 'together: check the sibling out, or point XCHAIN_NODE_DIR at it, rather than letting the '
                    + 'guard pass by skipping.');
            // A CHECKED-OUT sibling missing its pin is a broken tree, not a standalone
            // deploy, and skipping there would hide the very rotation this guards: a
            // rename or delete on the publisher side reads identically to a divergence.
            expect(fs.existsSync(NODE_DIR), `xchain-node is checked out at ${NODE_DIR} but pins no signing key at `
                + `${SIBLING_PIN}. The publisher's half of the trust anchor has been moved, renamed or deleted; `
                + 'this guard will not skip that away').to.equal(false);
            this.skip();
            return;
        }
        const mine = der(PIN);
        const theirs = der(SIBLING_PIN);
        expect(mine.equals(theirs),
            'the two pinned bootstrap signing keys have DIVERGED: '
            + `${PIN} (sha256 ${sha256(PIN)}...) vs ${SIBLING_PIN} (sha256 ${sha256(SIBLING_PIN)}...). `
            + 'A rotation updated one repo and not the other. Until both pins carry the same key, every '
            + 'restore of a newly published archive is refused fail-closed before the /data wipe and the '
            + 'container retries an archive that can never verify.').to.equal(true);
    });
});
