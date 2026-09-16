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
 * XChain UTXO Tracker - UTXO Tracker Class
 *
 ********************************************************************/

const config = require('../config')
const memoryBudget = require('../store/memory_budget')
const { getLogger } = require('../observability')

const CHECK_BLOCK_DELAY_MS = 1000 //1 second to continously ask for new block when all has been parsed

const BLOCKCHAIN_INFO_REFRESH_MS = 30000 //Re-poll the node tip at least this often during catch-up so the tracked tip stays current

const DB_TRANSACTION_BLOCKS_QUANTITY = 200

// Heap-pressure flush guard: dense BTC blocks stage ~17-90 MB of Buffer writes
// each, so a full 200-block batch can push V8 past its ceiling mid-parse. Flush
// early instead, at a threshold that must trip before any cgroup limit does.
const HEAP_FLUSH_THRESHOLD_MB = memoryBudget.heapFlushThresholdMB()

const SYNCED_THRESHOLD = 3

const SATOSHI_BIGINT = 100000000n

const DEBUG_TRACE = config.DEBUG_TRACE

const MEMPOOL_INTERVAL = 60000

const MEMPOOL_BATCH_SIZE = 1000

// Breathing room between mempool batches (CPU/IO). Kept small so the cumulative
// inter-batch sleep stays well under MEMPOOL_INTERVAL even for large mempools
// (e.g. 50k txs => 49 sleeps => ~73.5s of sleep at 1500ms, vs ~490s at 10s):
// a 10s sleep would keep mempoolBusy locked across every interval tick and
// leave pending-balance queries stale for the whole multi-batch window.
const MEMPOOL_INTER_BATCH_SLEEP = 1500

// Max consecutive getRawTransactions failures before we abandon this mempool
// pass. The node going down mid-pass would otherwise spin this retry loop
// forever, never reaching the outer finally that clears the busy flag.
const MEMPOOL_MAX_TX_FETCH_RETRIES = 5

// Consecutive block-fetch failures at the SAME height before the tracker treats
// the node as unrecoverably desynced (pruned past our cursor, or a permanent
// missing-block fault) and fails loud instead of retrying every 3s forever.
// Generous by design so ordinary node restarts / transient RPC blips still
// self-heal: at a 3s backoff this is ~1 minute of retrying before giving up.
// Override via XCHAIN_MAX_BLOCK_FETCH_RETRIES for slow-recovering nodes.
const BLOCK_FETCH_RETRY_SLEEP_MS = 3000

const MAX_BLOCK_FETCH_RETRIES = config.MAX_BLOCK_FETCH_RETRIES

// After this many consecutive fetch failures at one height on an AuxPoW chain,
// treat the failure as deterministic (e.g. an AuxPoW section skipAuxPow cannot
// traverse) and switch to getBlockReassembled, which
// rebuilds the pure block from getblockheader + verbose getblock + per-txid
// getrawtransaction and so never reads the AuxPoW bytes at all. Must stay well
// below MAX_BLOCK_FETCH_RETRIES so the fallback gets attempts in before the
// streak is misdiagnosed as a pruned-node desync and halts the tracker.
const AUXPOW_REASSEMBLE_AFTER = 5

const REMOVE_SPENT = true

const ETA_WINDOW_BLOCKS = 1000 //Rolling window size for ETA calculation

const MIN_VERIFICATION_PROGRESS_TO_PARSE = 0.99 //How much progress the node need to have to start parsing


// Hard ceiling on how many outputs a single-address query will materialize. A
// mega miner-coinbase/payout address can hold millions of UTXOs; loading them all
// into one array OOMs the process and takes the tracker down for every caller.
// Above this ceiling, unbounded queries (get_utxos / get_balance with no page
// limit) fail loud (HTTP 413) so callers page via /utxos?limit=&after= instead.
// Tune per host via UTXO_MAX_ADDRESS_OUTPUTS.
const MAX_ADDRESS_OUTPUTS = config.MAX_ADDRESS_OUTPUTS

const logger = getLogger();


// coinFromNetwork and resolveUndoBlocks are single-sourced in undo-blocks.js
// (imported above) so the live worker, seeder, orchestrator, and api.js share
// one env-override resolution semantics and can never drift (uuid:65309b82).
const PREFETCH_SIZE = 10 //Number of blocks to pre-fetch concurrently while processing the current one


// Single-byte key that persists pendingKMCleanup across restarts.
// 0x50 ('P') is unused by LevelUpDb's key schema (B/T/I/O/H/J/S/Z/K/M/N/W).
const P_PENDING_CLEANUP_KEY = Buffer.from([0x50])


// Single-byte key holding the deepest undo window this store has actually held
// (its high-water mark, clamped to the live undoBlocks). 0x51 ('Q') is unused by
// LevelUpDb's key schema (B/T/I/O/H/J/S/Z/K/M/N/W) and by 'P' above.
//
// Why the mark exists: a window shorter than undoBlocks has TWO causes, and the
// N records alone cannot tell them apart (both leave a contiguous window ending
// at the committed tip). One is a rollback interrupted mid-reorg. The other is a
// window that was never that deep yet, because UNDO_BLOCKS was RAISED under an
// existing store: the on-disk N index keeps the entries the old depth allowed
// and only grows back one per forward-synced block. LTC mainnet booted "48 of
// 120" the day after its per-chain default went 48 -> 120 (undo-blocks.js) and
// the boot line called it a 72-block rollback that never happened. The mark is
// what the second boot has that the first did not: a record of how deep the
// window ever got, so a window at or above it never shrank.
const Q_UNDO_WATERMARK_KEY = Buffer.from([0x51])

module.exports = {
    CHECK_BLOCK_DELAY_MS,
    BLOCKCHAIN_INFO_REFRESH_MS,
    DB_TRANSACTION_BLOCKS_QUANTITY,
    HEAP_FLUSH_THRESHOLD_MB,
    SYNCED_THRESHOLD,
    SATOSHI_BIGINT,
    DEBUG_TRACE,
    MEMPOOL_INTERVAL,
    MEMPOOL_BATCH_SIZE,
    MEMPOOL_INTER_BATCH_SLEEP,
    MEMPOOL_MAX_TX_FETCH_RETRIES,
    BLOCK_FETCH_RETRY_SLEEP_MS,
    MAX_BLOCK_FETCH_RETRIES,
    AUXPOW_REASSEMBLE_AFTER,
    REMOVE_SPENT,
    ETA_WINDOW_BLOCKS,
    MIN_VERIFICATION_PROGRESS_TO_PARSE,
    MAX_ADDRESS_OUTPUTS,
    logger,
    PREFETCH_SIZE,
    P_PENDING_CLEANUP_KEY,
    Q_UNDO_WATERMARK_KEY
}
