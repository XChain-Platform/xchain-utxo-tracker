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
 **********************************************************************
 *
 * XChain UTXO Tracker - restore archive validation (pure decision logic)
 *
 * The single-layer `restorebootstrap` flow (api.js decompressPigz) wipes /data
 * BEFORE it extracts, so an archive that fails its provenance signature, is the
 * wrong LAYOUT, fails its published checksum, or holds no LevelDB store at all
 * must be rejected up front or the live DB is destroyed and replaced with a
 * corrupt/empty/attacker-chosen store. These helpers are the pure decision core
 * (no fs / child_process) so they are unit-testable; api.js supplies the
 * member list, sidecar text, signature text, and computed digest.
 *
 *********************************************************************/

'use strict';

const path = require('path');

// The BootstrapService "wrapper" layout is an outer gzip whose members are these
// two files (inner payload + its checksum), NOT a LevelDB store. A real
// classic-level store never contains a file named `data.tar.gz` / `data.sha256`
// (it holds CURRENT, MANIFEST-*, *.ldb, *.log, LOCK, ...), so matching these exact
// names is a specific positive signal for the wrapper with no false positives on a
// genuine single-layer archive.
const WRAPPER_MEMBER_NAMES = ['data.tar.gz', 'data.sha256'];

// True when the archive's member list is the wrapper layout the single-layer
// restore cannot unwrap. Basenames are compared so a leading `./` or path prefix
// does not hide the signal.
function isWrapperArchive(memberNames) {
    if (!Array.isArray(memberNames)) return false;
    for (const raw of memberNames) {
        if (typeof raw !== 'string') continue;
        const base = path.posix.basename(raw.trim().replace(/\/+$/, ''));
        if (WRAPPER_MEMBER_NAMES.includes(base)) return true;
    }
    return false;
}

// Extract the sha256 hex digest from a `.sha256` sidecar. Accepts both the bare
// digest and the `sha256sum` format (`<64hex>  <filename>`); returns the lowercased
// 64-char hex string, or null when no valid digest is present.
function parseSha256Sidecar(text) {
    if (typeof text !== 'string') return null;
    const m = text.match(/\b[0-9a-fA-F]{64}\b/);
    return m ? m[0].toLowerCase() : null;
}

// A classic-level store always carries a `CURRENT` file naming its live manifest,
// plus the `MANIFEST-<n>` that file points at. Anything else is not a LevelDB store.
const LEVELDB_MANIFEST_PATTERN = /^MANIFEST-\d+$/;

// Normalize an archive member to `<dir>` / `<base>`, with `.` and a leading `./`
// collapsing to the empty directory so `CURRENT` and `./CURRENT` compare equal.
function memberParts(raw) {
    const clean = raw.trim().replace(/\/+$/, '');
    const dir = path.posix.dirname(clean);
    return { dir: (dir === '.' || dir === '/') ? '' : dir.replace(/^\.\//, ''),
             base: path.posix.basename(clean) };
}

// True when the archive's member list looks like a LevelDB store: `CURRENT` AND at
// least one `MANIFEST-<n>`, IN THE SAME DIRECTORY. A checksum proves only that the
// archive is the one that was published, never that it holds a store, so without this
// a correctly-checksummed tar of unrelated files passes validation and the
// unconditional pre-extract /data wipe leaves the tracker on a fresh empty DB.
//
// The same-directory requirement is the part that is easy to get wrong. Comparing
// bare basenames also accepted a `CURRENT` under one directory and a `MANIFEST-<n>`
// under an unrelated one, which is no store anywhere in the tree and still wiped the
// live DB. It deliberately does NOT require depth 0: the publisher (xchain-node
// BootstrapService) tars the whole tracker volume, so a genuine published archive
// carries the store one level down (`./xchain-utxo-tracker/CURRENT`), and refusing
// that here would make the only restore path reject every official bootstrap. A
// nested store that this gate passes but `tar -x -C <dbroot>` cannot place correctly
// is caught after extraction by assertExtractedStoreOrThrow in api.js, which fails
// loud instead of reporting success over a wiped database.
function hasRequiredLevelDbMembers(memberNames) {
    if (!Array.isArray(memberNames)) return false;
    const currentDirs = new Set();
    const manifestDirs = new Set();
    for (const raw of memberNames) {
        if (typeof raw !== 'string') continue;
        const { dir, base } = memberParts(raw);
        if (base === 'CURRENT') currentDirs.add(dir);
        else if (LEVELDB_MANIFEST_PATTERN.test(base)) manifestDirs.add(dir);
    }
    for (const dir of currentDirs) if (manifestDirs.has(dir)) return true;
    return false;
}

// Parse a detached bootstrap signature file. The publisher (xchain-node's
// BootstrapService, driven by scripts/publish-bootstraps.sh) writes
// `v1 ed25519 <base64>`, where the signature covers the raw 32 bytes of the archive's
// sha256 digest (digest-then-sign, so a multi-GB archive is never buffered). Returns
// the raw signature bytes, or null when the text is not a v1 ed25519 line.
function parseDetachedSignature(text) {
    if (typeof text !== 'string') return null;
    const parts = text.trim().split(/\s+/);
    if (parts.length !== 3 || parts[0] !== 'v1' || parts[1] !== 'ed25519') return null;
    const sig = Buffer.from(parts[2], 'base64');
    // An ed25519 signature is exactly 64 bytes; anything else means a truncated or
    // non-base64 payload that Buffer.from accepted silently.
    return sig.length === 64 ? sig : null;
}

module.exports = {
    isWrapperArchive,
    parseSha256Sidecar,
    hasRequiredLevelDbMembers,
    parseDetachedSignature,
};
