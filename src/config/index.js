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
 **********************************************************************
 *
 * The environment, read in one place.
 *
 * Every knob an operator can set is read here and nowhere else, so the set of
 * things that can be changed is one file long, and the default a knob falls
 * back to sits beside the coercion that produces it instead of being restated
 * in a comment at each place the value is used.
 *
 * WHY THESE ARE GETTERS AND NOT VALUES. Several of these were read at require
 * time in the module that used them, so a suite that sets the variable and then
 * reloads the module under test saw the new value. Resolving them eagerly here
 * would freeze whatever the environment held when the FIRST module pulled this
 * file in, which is a boot-order dependency no caller can see and no test can
 * reset. A getter keeps the old semantics: the value is whatever the
 * environment says at the moment it is asked for.
 *
 * Coercion is carried over verbatim from each old read site, including the
 * inconsistencies. `Number(x) > 0` and `parseInt(x ?? d, 10)` do not agree on
 * what a trailing-garbage string means, and this file is not the place to
 * decide that: changing one would be a behaviour change wearing a refactor's
 * clothes.
 *
 ********************************************************************/

'use strict';

// A flag is on for exactly the two spellings the old read sites accepted, so
// FALSE, 0 and yes all stay off exactly as they did before.
function flag(raw) {
    return raw === '1' || raw === 'true';
}

module.exports = {
    // Per-insert tracing for the missing-output investigation, off in
    // production: it emits one line per output write.
    get DEBUG_TRACE() { return flag(process.env.DEBUG_TRACE); },

    // The same tracing on the store side, one line per staged deletion and a
    // summary per transaction. A separate switch from DEBUG_TRACE on purpose:
    // the store is loud enough to drown the loop.
    get TRACE_UTXO() { return flag(process.env.TRACE_UTXO); },

    // How many times a single block fetch is retried before the loop gives up.
    // Generous by design: at the three-second backoff that is about a minute of
    // retrying, so an ordinary node restart self-heals instead of halting.
    get MAX_BLOCK_FETCH_RETRIES() {
        const n = Number(process.env.XCHAIN_MAX_BLOCK_FETCH_RETRIES);
        return n > 0 ? n : 20;
    },

    // Ceiling on an unpaged address query. A mega payout address can hold
    // millions of outputs, and loading them into one array takes the whole
    // service down for every caller, so past this the query fails loud and the
    // caller pages instead.
    get MAX_ADDRESS_OUTPUTS() {
        const n = Number(process.env.UTXO_MAX_ADDRESS_OUTPUTS);
        return n > 0 ? Math.floor(n) : 500000;
    },

    // Per-request timeout on the coin node's RPC, in milliseconds.
    get NODE_RPC_TIMEOUT_MS() { return parseInt(process.env.NODE_RPC_TIMEOUT ?? '30000', 10); },

    // Store write-buffer size. Larger buffers mean fewer, bigger compactions on
    // a bulk load; the default is eight times the engine's own.
    get LEVELDB_WRITE_BUFFER_BYTES() {
        return parseInt(process.env.LEVELDB_WRITE_BUFFER_BYTES ?? String(64 * 1024 * 1024), 10);
    },

    // The next three are handed on RAW, as strings, because the module that
    // uses each one applies its own parse and its own clamp against a derived
    // budget. Parsing here would give the caller a number it would then have to
    // tell apart from a value it derived itself.

    // Explicit block-cache size, overriding whatever the memory budget derives.
    get LEVELDB_CACHE_BYTES() { return process.env.LEVELDB_CACHE_BYTES; },

    // Explicit heap-flush threshold in MB, overriding the derived one.
    get HEAP_FLUSH_THRESHOLD_MB() { return process.env.HEAP_FLUSH_THRESHOLD_MB; },

    // How long a shutdown may drain before the process exits hard.
    get SHUTDOWN_TIMEOUT_MS() { return process.env.SHUTDOWN_TIMEOUT_MS; },
};
