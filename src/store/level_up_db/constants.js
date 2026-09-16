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
 **********************************************************************/

const config = require('../../config')
const { getLogger } = require('../../observability');

// Debug-only tracing for the missing-O-record investigation. Gated behind
// TRACE_UTXO=1 to keep prod cost at zero. Emits one line per insertOutput,
// one per staged O deletion in removeOutputsWithInputsBatch, and a summary
// per endTransaction. Logs go to stdout (docker logs).
const DEBUG_TRACE = config.TRACE_UTXO

const logger = getLogger();

// String-keyed metadata entries. The DB is opened with keyEncoding:'buffer',
// so these are stored as their UTF-8 byte Buffers, first byte 'L' = 0x4C.
// 0x4C is reserved and unused by any k* builder: it sits between
// P_OUT_DEL ('K' = 0x4B) and P_HINT_DEL ('M' = 0x4D), not after everything.
const PREFIX_LAST_BLOCK_HEIGHT = Buffer.from("LAST_BLOCK_HEIGHT")

const PREFIX_LAST_BLOCK_HASH   = Buffer.from("LAST_BLOCK_HASH")

// Single-byte prefix values
const P_BLOCK      = 0x42  // 'B'

const P_TX         = 0x54  // 'T'

const P_INPUT      = 0x49  // 'I'

const P_OUTPUT     = 0x4F  // 'O'

const P_OUT_HINT   = 0x48  // 'H'

const P_IN_HINT    = 0x4A  // 'J'

const P_SCRIPT_BLK = 0x53  // 'S'

const P_BLK_SCRIPT = 0x5A  // 'Z'

const P_OUT_DEL    = 0x4B  // 'K'

const P_HINT_DEL   = 0x4D  // 'M'

const P_STORED_BLK = 0x4E  // 'N'

const P_OUT_BLK    = 0x57  // 'W' - creation-block reverse index for outputs

// O value: [value(8)][height(4)][fullTxHash(32)] = 44 bytes, plus an OPTIONAL
// 45th coinbase-flag byte (0x01) appended only for coinbase outputs.
// height = -1 stored as 0xFFFFFFFF (twos-complement Int32)
const ZERO_HASH = '0'.repeat(64)

const EMPTY = Buffer.alloc(0)

// LevelUpStore class

// LRU-ish cache for recently-written output values, keyed by txHash8 plus a
// packed 2-char outputIndex (see insertOutput). UTXO locality: most spends
// consume outputs created within the last few thousand blocks, so a bounded
// in-memory cache absorbs a large fraction of Phase 2 reads in
// removeOutputsWithInputsBatch without touching the DB. Map insertion order
// gives FIFO eviction; entries are also evicted on spend.
const OUTPUT_CACHE_MAX = 2_000_000

const KNOWN_SCRIPTS_MAX = 2_000_000

module.exports = { DEBUG_TRACE, logger, PREFIX_LAST_BLOCK_HEIGHT, PREFIX_LAST_BLOCK_HASH, P_BLOCK, P_TX, P_INPUT, P_OUTPUT, P_OUT_HINT, P_IN_HINT, P_SCRIPT_BLK, P_BLK_SCRIPT, P_OUT_DEL, P_HINT_DEL, P_STORED_BLK, P_OUT_BLK, ZERO_HASH, EMPTY, OUTPUT_CACHE_MAX, KNOWN_SCRIPTS_MAX }
