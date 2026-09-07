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
 * Fail-closed boot check for the BigInt-safe bufferutils patch.
 *
 * src/applyBufferutilsPatch.js rewrites bitcoinjs-lib's 64-bit reader in
 * process, because the stock one throws above 2^53-1 sat and a Dogecoin
 * output over ~90.07M DOGE would wedge block decode. That patch is applied,
 * not verified: a shadowed bitcoinjs-lib copy, a node_modules dedup change or
 * a reordered require can leave it inert with no boot-time signal. The tracker
 * then starts normally and either throws mid-parse on the first oversized
 * output or, worse, decodes it differently from every correctly patched peer,
 * committing a UTXO set that disagrees with the ledger for the same block.
 *
 * xchain-decoder refuses to start in that state (XChainDecoder.js, the
 * bigIntBufferutilsActive check in start()); this module is the tracker's half
 * of that parity, called from every site that constructs an XChainBlockDecoder.
 *
 ********************************************************************/

'use strict'

// Probe the LIVE bufferutils module with a synthetic 2^53 uint64, one past the
// stock reader's ceiling. Same shape as applyBufferutilsPatch.js's idempotence
// guard and the decoder's: read at call time, never at module load, so the
// answer reflects whatever the patch did. The module is injectable for testing.
// Returns false on any failure (an unrecognizable module reads as "not patched").
function bigIntBufferutilsActive(bufferutils){
    try {
        const bu = bufferutils || require('bitcoinjs-lib/src/bufferutils')
        if (!bu.BufferReader) return false
        new bu.BufferReader(Buffer.from([0, 0, 0, 0, 0, 0, 0x20, 0])).readUInt64()
        return true
    } catch(_){
        return false
    }
}

// Refuse to run a Dogecoin decode path on an unpatched reader. Only dogecoin can
// carry an output past the stock ceiling, so every other coin is a no-op. Throws
// rather than warns, and deliberately uncaught: an inactive patch is
// ENVIRONMENT-dependent, so this instance would diverge from correctly patched
// peers rather than fail the same way everywhere. `context` names the entry point
// so the failing process is obvious from the log line.
function assertBigIntBufferutils(coin, context, bufferutils){
    if (coin !== 'dogecoin') return
    if (bigIntBufferutilsActive(bufferutils)) return
    throw new Error('CRITICAL: bitcoinjs-lib bufferutils BigInt-safe 64-bit reader is NOT active on a ' +
        'Dogecoin ' + (context || 'utxo-tracker') + '. A DOGE output > 2^53-1 sat (~90.07M DOGE) will ' +
        'throw during block decode and wedge this process permanently, or decode differently than ' +
        'correctly patched peers. src/applyBufferutilsPatch.js should have applied it in-process; ' +
        'investigate before running on mainnet.')
}

module.exports = { bigIntBufferutilsActive, assertBigIntBufferutils }
