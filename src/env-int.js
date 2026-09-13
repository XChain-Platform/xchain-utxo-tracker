/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 *********************************************************************/

'use strict'

// Whole-string integer read for operator-supplied numeric config. THE one
// numeric env reader in this component; new knobs call it rather than hand-roll
// a fourth copy.
//
// parseInt reads a numeric PREFIX, so it reads a typo as intent: '1.5' becomes
// 1, '12garbage' becomes 12, '0oops' becomes 0. A Number.isInteger or
// Number.isFinite guard placed AFTER that coercion inspects the already-mangled
// number, never the string the operator wrote, so it can only ever pass. Number()
// on the trimmed whole string refuses all three. Two shipped resolvers had the
// guard the wrong way round (items 7713, 7714): a malformed
// XCHAIN_UNDO_BLOCKS_<COIN> shortened the reorg-recovery window instead of
// keeping the per-chain default, and a malformed concurrency cap resolved to 0,
// which disables admission control outright.
//
// Absent and malformed are reported separately: an unset knob is normal and
// silent, a typo'd one warns.
function readInt(raw){
    if (raw === undefined || raw === null || String(raw).trim() === '') {
        return { absent: true, value: null }
    }
    const parsed = Number(String(raw).trim())
    if (!Number.isInteger(parsed)) return { absent: false, value: null }
    return { absent: false, value: parsed }
}

// Warn-and-default resolver over readInt for a process.env knob. Never throws:
// a misconfigured process must still come up on its default path, and a FATAL
// here once turned one typo into a crash-loop where a graceful fallback was
// intended (api.js bulk-sync pre-flight).
function envInt(name, fallback, min, warnSuffix){
    const raw = process.env[name]
    const read = readInt(raw)
    if (read.absent) return fallback
    if (read.value === null || read.value < min) {
        console.error(
            'WARNING: ' + name + "='" + raw + "' is not an integer >= " + min +
            '; falling back to ' + fallback + '.' + (warnSuffix ? ' ' + warnSuffix : ''))
        return fallback
    }
    return read.value
}

module.exports = { readInt, envInt }
