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
 * BEFORE it extracts, so an archive that is the wrong LAYOUT or fails its
 * published checksum must be rejected up front or the live DB is destroyed and
 * replaced with a corrupt/empty store. These helpers are the pure decision core
 * (no fs / child_process) so they are unit-testable; api.js supplies the
 * member list, sidecar text, and computed digest.
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

module.exports = { isWrapperArchive, parseSha256Sidecar, WRAPPER_MEMBER_NAMES };
