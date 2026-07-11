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

module.exports = { DEFAULT_UNDO_BLOCKS, FALLBACK_UNDO_BLOCKS, MAX_SAFE_UNDO_BLOCKS }
