'use strict'

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
 * XChain UTXO Tracker - Bulk Sync Derive-Keys
 *
 * Consumes the merger's intermediate streams and emits one fixed-record
 * file per LevelUpDb prefix (B/T/I/O/H/J/N/S/W/Z) + a small L.json. The
 * loader streams each file and issues db.batch() writes.
 *
 * Record layout per output file: concatenated (key || value) records, no
 * header, fixed size. Files are sorted ascending by key.
 *
 *   B.dat   33+40 =  73B  (key: 'B'+blockHash32;        val: heightBE(4)+tsBE(4)+prevHash32)
 *   T.dat    9+32 =  41B  (key: 'T'+txHash8(8);         val: blockHash32)
 *   I.dat   13+ 8 =  21B  (key: 'I'+prevTxHash8+voutBE; val: spenderTxHash8)
 *   O.dat   45+45 =  90B  (key: 'O'+script32+txHash8+voutBE;
 *                           val: valueBE(8)+heightBE(4)+fullTxHash32+coinbase(1))
 *                           The coinbase byte is always present in this
 *                           intermediate so the record stays fixed-width for the
 *                           external sort; the loader re-encodes it to the live
 *                           path's optional-byte form (44B normal / 45B coinbase).
 *   H.dat   13+32 =  45B  (key: 'H'+txHash8+voutBE;     val: script32)
 *   J.dat   21+ 0 =  21B  (key: 'J'+spenderTxHash8+prevTxHash8+prevVoutBE)
 *   N.dat   33+ 0 =  33B  (key: 'N'+blockHash32)
 *   S.dat   33+ 4 =  37B  (key: 'S'+script32;           val: heightBE(4))
 *   W.dat   45+32 =  77B  (key: 'W'+blockHash32+txHash8+voutBE; val: script32)
 *                           Creation-block reverse index. One record per output
 *                           in the pre-cancellation outputs stream (i.e. at
 *                           output-creation time, before spends are applied) so
 *                           an output later spent within the seeded range still
 *                           gets a creation record - exactly where the live path
 *                           calls insertOutputBlock. This is the ONLY index the
 *                           reorg unwind (removeCreatedOutputsInBlock) scans to
 *                           purge outputs created in a rolled-back seeded block.
 *                           Windowed to the last undoBlocks seeded blocks: the
 *                           unwind can't reach deeper, and the live tracker
 *                           prunes W past that window, so deeper seeded
 *                           records would be permanent dead weight.
 *   Z.dat   65+ 0 =  65B  (key: 'Z'+blockHash32+script32)
 *                           Block->script reverse index. Windowed to the last
 *                           undoBlocks seeded blocks like W: its only reader is
 *                           the reorg unwind (removeOutputScriptsInBlock), which
 *                           can't reach deeper, and the live tracker prunes Z as
 *                           blocks age out (removeOutputScriptsBlockIndexOnly).
 *                           S is NOT windowed: it backs the live first-seen query.
 *
 *   L.json             { LAST_BLOCK_HEIGHT: "<hex>", LAST_BLOCK_HASH: "<hex>" }
 *
 * S/Z semantics (option A): scripts are derived from the FULL outputs
 * stream (pre-cancellation) so scripts that appeared and were fully
 * spent are still emitted. For each unique scriptHash, the record
 * retained is the one with the lowest rowId in the source file (i.e.
 * the earliest appearance in block/tx/vout order.
 *
 ********************************************************************/

const { LAYOUT }               = require('./derive_keys/record_layout.js')
const { deriveKeys }           = require('./derive_keys/derive_keys_pass.js')

// Per-chain N-window defaults, single-sourced in undo-blocks.js so the bulk-seeded
// N-prefix always covers at least as many blocks as the live reorg depth guard allows
// (a hand-copied second table re-opens the per-chain reorg gap).
// resolveUndoBlocks is single-sourced in undo-blocks.js so the seeded N-window,
// the live undo window, the orchestrator tip-safety clamp, and api.js can never
// drift under the same env (uuid:65309b82). Re-exported below so existing
// callers (orchestrator.js, api.js) keep importing it from here unchanged.
// The DEFAULTS table itself is deliberately NOT imported: the seeder reads the
// window only through the resolver, and a binding to the raw table here is how a
// hand-copied second table gets started again.
const { resolveUndoBlocks } = require('../../chain/undo_blocks.js')

module.exports = { deriveKeys, LAYOUT, resolveUndoBlocks }
