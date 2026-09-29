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
 * The `restorebootstrap` flow (api/compression.js decompressPigz) wipes /data
 * BEFORE it extracts, so an archive that fails its provenance signature, fails
 * its published checksum, names another module, coin or network in its
 * bootstrap.json, or holds no LevelDB store at the archive root (none at all,
 * or one nested under a subdirectory) must be rejected up front or the live DB
 * is destroyed and replaced with a corrupt/empty/foreign/attacker-chosen store.
 * The BootstrapService wrapper layout is NOT one of those: it is detected so it
 * can be unwrapped and its inner payload checksum-verified, never refused.
 * These helpers are the pure decision core (no fs / child_process) so they are
 * unit-testable; api/errors.js supplies the member list, sidecar text,
 * signature text, metadata text, and computed digest.
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

// True when the archive's member list is the BootstrapService wrapper layout, so
// validateBootstrapArchiveOrThrow unwraps it and verifies the inner data.tar.gz
// instead of treating the outer archive as a store. Basenames are compared so a
// leading `./` or path prefix does not hide the signal.
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

// True when the archive's member list holds a LevelDB store AT THE ARCHIVE ROOT:
// `CURRENT` AND at least one `MANIFEST-<n>`, both at depth 0. A checksum proves only
// that the archive is the one that was published, never that it holds a store, so
// without this a correctly-checksummed tar of unrelated files passes validation and
// the unconditional pre-extract /data wipe leaves the tracker on a fresh empty DB.
//
// Both halves must sit in the root directory. Comparing bare basenames accepted a
// `CURRENT` under one directory and a `MANIFEST-<n>` under an unrelated one, which is
// no store anywhere in the tree. A pair nested one level down is a store, but
// `tar -x -C <dbroot>` preserves the archive's directories, so it lands where
// ClassicLevel never looks and assertExtractedStoreOrThrow refuses it only after the
// wipe. Every producer packs from inside the store (xchain-node BootstrapService tars
// the tracker volume, whose root IS the store, and getbootstrap tars /data/<DB_NAME>),
// so refusing a nested store here costs no restore that could have succeeded.
function hasRequiredLevelDbMembers(memberNames) {
    if (!Array.isArray(memberNames)) return false;
    let hasCurrent = false;
    let hasManifest = false;
    for (const raw of memberNames) {
        if (typeof raw !== 'string') continue;
        const { dir, base } = memberParts(raw);
        if (dir !== '') continue;
        if (base === 'CURRENT') hasCurrent = true;
        else if (LEVELDB_MANIFEST_PATTERN.test(base)) hasManifest = true;
    }
    return hasCurrent && hasManifest;
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

// The identity member the publisher writes first in the wrapper, its only format,
// and the module name every tracker bootstrap declares in it.
const BOOTSTRAP_META_MEMBER = 'bootstrap.json';
const BOOTSTRAP_META_FORMAT = 1;
const TRACKER_MODULE = 'xchain-utxo-tracker';
const ARCHIVE_IDENTITY_FIELDS = ['module', 'coin', 'network'];

// Lowercased, trimmed identity value, or null when the field is absent or blank.
function identityValue(value) {
    if (typeof value !== 'string') return null;
    const v = value.trim().toLowerCase();
    return v === '' ? null : v;
}

// This tracker's restore target. xchain-node sets NETWORK to `<coin>-<net>` (for
// example `bitcoin-mainnet`) and no COIN, so split at the LAST '-', which keeps a
// hyphenated coin name whole; a value that does not split leaves coin/network null.
function trackerArchiveIdentity(network) {
    const n = identityValue(network) || '';
    const i = n.lastIndexOf('-');
    const splits = i > 0 && i < n.length - 1;
    return { module: TRACKER_MODULE, coin: splits ? n.slice(0, i) : null, network: splits ? n.slice(i + 1) : null };
}

// Parse bootstrap.json text into { module, coin, network }. Null when the text is
// absent, not JSON, or not format 1: an archive published before the member existed
// reads as "identity unknown", never as an error.
function parseArchiveMeta(text) {
    if (typeof text !== 'string') return null;
    let parsed;
    try { parsed = JSON.parse(text); } catch (_) { return null; }
    if (!parsed || typeof parsed !== 'object' || parsed.format !== BOOTSTRAP_META_FORMAT) return null;
    return { module: identityValue(parsed.module), coin: identityValue(parsed.coin), network: identityValue(parsed.network) };
}

// Compare an archive's declared identity with the restore target, case-insensitively.
// Only a field present on BOTH sides that differs is a mismatch; a field either side
// lacks is unchecked (legacy archives carry no member, converter-built ones null coin).
function compareArchiveIdentity(meta, target) {
    const mismatches = [];
    const unchecked = [];
    for (const field of ARCHIVE_IDENTITY_FIELDS) {
        const archive = identityValue(meta && meta[field]);
        const wanted = identityValue(target && target[field]);
        if (archive === null || wanted === null) unchecked.push(field);
        else if (archive !== wanted) mismatches.push({ field, archive, target: wanted });
    }
    const status = mismatches.length > 0 ? 'mismatch' : unchecked.length > 0 ? 'unchecked' : 'match';
    return { status, mismatches, unchecked };
}

module.exports = {
    isWrapperArchive,
    parseSha256Sidecar,
    hasRequiredLevelDbMembers,
    parseDetachedSignature,
    BOOTSTRAP_META_MEMBER,
    trackerArchiveIdentity,
    parseArchiveMeta,
    compareArchiveIdentity,
};
