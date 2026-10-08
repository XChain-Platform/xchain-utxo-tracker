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
 * Every bounded cap resolves through the strict integer reader in env_int.js,
 * so Infinity, a fraction or a typo warns and keeps the default instead of
 * silently lifting or zeroing the cap. The remaining parseInt reads
 * (NODE_RPC_TIMEOUT_MS, LEVELDB_WRITE_BUFFER_BYTES) are still carried over
 * verbatim from their old read sites.
 *
 ********************************************************************/

'use strict';

const { envInt, intKnob } = require('./env_int');

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
        return intKnob('XCHAIN_MAX_BLOCK_FETCH_RETRIES', process.env.XCHAIN_MAX_BLOCK_FETCH_RETRIES, { fallback: 20, min: 1 });
    },

    // Ceiling on an unpaged address query. A mega payout address can hold
    // millions of outputs, and loading them into one array takes the whole
    // service down for every caller, so past this the query fails loud and the
    // caller pages instead.
    get MAX_ADDRESS_OUTPUTS() {
        return intKnob('UTXO_MAX_ADDRESS_OUTPUTS', process.env.UTXO_MAX_ADDRESS_OUTPUTS, { fallback: 500000, min: 1 });
    },

    // Per-request timeout on the coin node's RPC, in milliseconds.
    get NODE_RPC_TIMEOUT_MS() { return parseInt(process.env.NODE_RPC_TIMEOUT ?? '30000', 10); },

    // Store write-buffer size. Larger buffers mean fewer, bigger compactions on
    // a bulk load; the default is eight times the engine's own.
    get LEVELDB_WRITE_BUFFER_BYTES() {
        return parseInt(process.env.LEVELDB_WRITE_BUFFER_BYTES ?? String(64 * 1024 * 1024), 10);
    },

    // Ceiling on the store's open file descriptors. Defaults match the engine's
    // own (classic-level README), so an unset knob changes nothing; a working
    // set larger than maxOpenFiles * maxFileSize churns descriptors instead of
    // holding them open.
    get LEVELDB_MAX_OPEN_FILES() {
        return envInt('LEVELDB_MAX_OPEN_FILES', 1000, 1);
    },

    // Ceiling on a single on-disk table file's size, in bytes, before the store
    // rolls to a new one. Defaults match the engine's own.
    get LEVELDB_MAX_FILE_SIZE_BYTES() {
        return envInt('LEVELDB_MAX_FILE_SIZE_BYTES', 2 * 1024 * 1024, 1);
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
    // Identity of the chain this tracker serves, handed on raw.
    get COIN() { return process.env.COIN; },
    get NETWORK() { return process.env.NETWORK; },

    // Coin node connection, handed on raw.
    get NODE_URL() { return process.env.NODE_URL; },
    get NODE_PORT() { return process.env.NODE_PORT; },
    get NODE_USER() { return process.env.NODE_USER; },
    get NODE_PASSWORD() { return process.env.NODE_PASSWORD; },

    get UTXO_TRACKER_API_PORT() { return process.env.UTXO_TRACKER_API_PORT; },

    // Merged-mining chains carry an auxiliary proof of work in the header.
    get AUX_POW() { return flag(process.env.AUX_POW); },


    // Handed on raw: the caller validates it against its own fallback and floor.
    get NODE_RPC_STALE_MS_RAW() { return process.env.UTXO_TRACKER_NODE_RPC_STALE_MS; },

    get BOOTSTRAP_PUBKEY() { return process.env.UTXO_TRACKER_BOOTSTRAP_PUBKEY; },
    get BOOTSTRAP_RESTORE_ALLOW_UNSIGNED() { return process.env.BOOTSTRAP_RESTORE_ALLOW_UNSIGNED; },
    get BOOTSTRAP_RESTORE_ALLOW_UNVERIFIED() { return process.env.BOOTSTRAP_RESTORE_ALLOW_UNVERIFIED; },

    get UTXO_TRACKER_API_KEY() { return process.env.UTXO_TRACKER_API_KEY || ''; },

    // Largest JSON-RPC batch accepted.
    get MAX_JSONRPC_BATCH() {
        return intKnob('UTXO_MAX_RPC_BATCH', process.env.UTXO_MAX_RPC_BATCH, { fallback: 20, min: 1 });
    },

    // Largest page a single limit request may ask for.
    get MAX_PAGE_LIMIT() {
        return intKnob('UTXO_MAX_PAGE_LIMIT', process.env.UTXO_MAX_PAGE_LIMIT, { fallback: 10000, min: 1 });
    },

    get BULK_SYNC_WORK_DIR() { return process.env.BULK_SYNC_WORK_DIR; },

    get CORS_ORIGIN() { return process.env.CORS_ORIGIN; },
    get UTXO_TRACKER_RATE_LIMIT_RPM() { return process.env.UTXO_TRACKER_RATE_LIMIT_RPM; },
    get UTXO_TRACKER_MAX_CONCURRENT_PROBES() { return process.env.UTXO_TRACKER_MAX_CONCURRENT_PROBES; },
    get UTXO_TRACKER_MAX_CONCURRENT_REQUESTS() { return process.env.UTXO_TRACKER_MAX_CONCURRENT_REQUESTS; },

    // The environment a spawned child inherits, whole and live.
    get CHILD_ENV() { return process.env; },
};
