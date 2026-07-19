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

// Per-chain reorg-recovery window (the "undo blocks" depth), block-time-scaled so each
// chain keeps roughly 120 minutes of reorg headroom: DOGE's ~1-minute blocks need a far
// deeper window than BTC's ~10-minute blocks for the same wall-clock protection.
//
// SINGLE SOURCE. Imported by both the live incremental worker (XChainUtxoTracker.js) and
// the bulk seeder (bulk-sync/merger/derive-keys.js) so the seeded N-prefix can never drift
// below the live reorg depth guard for one chain. Maintaining two hand-copied tables
// re-opened exactly that per-chain gap (the one 51aab3b closed) whenever an operator
// re-tuned one chain's depth in only one file. A per-chain re-tune now happens here, once.
const DEFAULT_UNDO_BLOCKS = { BTC: 12, LTC: 48, DOGE: 120 }
const FALLBACK_UNDO_BLOCKS = 12

// The recovery window MUST NOT exceed the decoder's dispenser-expiry safe depth.
// This value MUST equal `DISPENSER_EXPIRE_SAFE_DEPTH` in the decoder
// (xchain-decoder/src/XChainDecoder.js, = deepest DEFAULT_UNDO_BLOCKS window + 6):
// the decoder aborts reorg recovery past that depth, so an XCHAIN_UNDO_BLOCKS_<COIN>
// env override that raises a chain's tracker window above this ceiling silently
// splits the two components' effective reorg windows. Raising either constant
// requires raising both, in lockstep.
const MAX_SAFE_UNDO_BLOCKS = 126

// Map a network string ('bitcoin-mainnet', 'dogecoin-regtest', ...) to a coin code.
function coinFromNetwork(network){
    const n = String(network || '').toLowerCase()
    if (n.startsWith('bitcoin'))  return 'BTC'
    if (n.startsWith('litecoin')) return 'LTC'
    if (n.startsWith('dogecoin')) return 'DOGE'
    return null
}

// SINGLE-SOURCED env-override resolver, shared by the live worker
// (XChainUtxoTracker.js), the bulk seeder (derive-keys.js), the orchestrator,
// and api.js. Two hand-coded copies had diverged: the live one honored a
// non-positive override via `parseInt(...) || default` (a negative value is
// truthy, so `XCHAIN_UNDO_BLOCKS_DOGE=-5` yielded -5 and degenerated the aging
// loop into a mass K/M-undo purge), while the seeder rejected it via `> 0`,
// letting the seeded N-window drift from the live undo window under the identical
// env. This single resolver rejects non-positive/non-integer overrides (falls
// back to the per-chain default) and applies the MAX_SAFE warning uniformly.
// Resolution order: explicit optsUndoBlocks → positive env override → per-chain
// default → global fallback.
function resolveUndoBlocks(network, optsUndoBlocks){
    const coin = coinFromNetwork(network)
    const envKey = coin ? ('XCHAIN_UNDO_BLOCKS_' + coin) : ''
    const envVal = parseInt(process.env[envKey], 10)
    let resolved
    if (Number.isInteger(optsUndoBlocks) && optsUndoBlocks > 0) {
        resolved = optsUndoBlocks
    } else if (Number.isInteger(envVal) && envVal > 0) {
        resolved = envVal
    } else {
        resolved = (coin && DEFAULT_UNDO_BLOCKS[coin]) || FALLBACK_UNDO_BLOCKS
    }
    // Loud warning (do NOT clamp or throw: the override is a deliberate operator
    // knob) when the resolved window exceeds the decoder's dispenser-expiry safe
    // depth. Past that ceiling the decoder aborts reorg recovery while the tracker
    // keeps auto-recovering, silently splitting the two effective reorg windows.
    if (resolved > MAX_SAFE_UNDO_BLOCKS) {
        console.error(
            'WARNING: resolved undo-blocks window for ' + (coin || network) + ' is ' + resolved +
            ', which exceeds the decoder dispenser-expiry safe depth (' + MAX_SAFE_UNDO_BLOCKS + '). ' +
            'The decoder will abort reorg recovery past ' + MAX_SAFE_UNDO_BLOCKS + ' blocks while this ' +
            'tracker auto-recovers, splitting the two effective reorg windows. Raise ' +
            'DISPENSER_EXPIRE_SAFE_DEPTH in the decoder to match, or lower ' + (envKey || 'the override') + '.'
        )
    }
    return resolved
}

module.exports = { DEFAULT_UNDO_BLOCKS, FALLBACK_UNDO_BLOCKS, MAX_SAFE_UNDO_BLOCKS, coinFromNetwork, resolveUndoBlocks }
