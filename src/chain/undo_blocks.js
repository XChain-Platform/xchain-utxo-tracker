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

// Canonical coin registry: the one name->tick table this file may consult.
const coins = require('../coins')
// The one strict numeric env reader (see src/config/env_int.js for why parseInt is not it).
const { envInt } = require('../config/env_int')
const { getLogger } = require('../observability');
const logger = getLogger();

// Per-chain, per-network reorg-recovery window (the "undo blocks" depth). On
// mainnet it is block-time-scaled so each chain keeps roughly 120 minutes of reorg
// headroom: DOGE's ~1-minute blocks need a far deeper window than BTC's ~10-minute
// blocks for the same wall-clock protection.
//
// SINGLE SOURCE. Imported by both the live incremental worker (XChainUtxoTracker.js) and
// the bulk seeder (bulk-sync/merger/derive-keys.js) so the seeded N-prefix can never drift
// below the live reorg depth guard for one chain. Maintaining two hand-copied tables
// re-opened exactly that per-chain gap (the one 51aab3b closed) whenever an operator
// re-tuned one chain's depth in only one file. A per-chain re-tune now happens here, once.
// A tick registered in src/coins with no entry here is REFUSED rather than given
// a generic window (item 5803): the window is a consensus-relevant per-chain
// value, and the chain that needs one most is a fast one, which is exactly the
// chain a generic default under-protects.
//
// TESTNET IS SIZED SEPARATELY, and every coin's testnet sits at the ceiling.
// Nominal block time is the wrong sizing input for a testnet: its minimum-
// difficulty rule admits a difficulty-1 block after a gap (20 minutes on
// bitcoin testnet3), so a lone miner can extend a private branch regardless of
// the network's difficulty and forks run far deeper than the same wall-clock
// span on mainnet. Twice now the window has been
// outrun by exactly that, each time by a testnet reading its coin's MAINNET
// number: on 2026-09-01 a litecoin testnet fork walked past LTC's then-48
// (the stored tip was a fork of the node's chain, the rollback exhausted the
// window, and the only exit was a full tracker rebuild), and on 2026-09-15 a
// bitcoin testnet tracker halted at 150774 with the persisted window drained
// to zero, because the table was keyed by coin alone and BTC testnet carried
// mainnet's 12. LTC was raised to 120 after the first event and BTC testnet
// was left alone, which is the gap the second event fell through. 120 is the
// deepest value this table can carry without also raising MAX_SAFE_UNDO_BLOCKS
// below and DISPENSER_EXPIRE_SAFE_DEPTH in the decoder, which move in lockstep.
//
// Regtest keeps the mainnet numbers, unchanged from when the table was keyed
// by coin: a regtest chain is mined on demand by a harness that decides its
// own fork depth, and the reorg suites on the rail are sized against these.
//
// FLAT KEYS, <TICK>_<NET>, on purpose. The decoder's dispenser_safe_depth
// conformance suite reads this export and takes Math.max over its VALUES to
// prove DISPENSER_EXPIRE_SAFE_DEPTH clears the deepest window in this table;
// a nested per-coin shape would hide the testnet column from that read.
const DEFAULT_UNDO_BLOCKS = {
    BTC_MAINNET: 12,  LTC_MAINNET: 120, DOGE_MAINNET: 120,
    BTC_TESTNET: 120, LTC_TESTNET: 120, DOGE_TESTNET: 120,
    BTC_REGTEST: 12,  LTC_REGTEST: 120, DOGE_REGTEST: 120
}

// The recovery window MUST NOT exceed the decoder's dispenser-expiry safe depth.
// This value MUST equal `DISPENSER_EXPIRE_SAFE_DEPTH` in the decoder
// (xchain-decoder/src/XChainDecoder.js, = deepest DEFAULT_UNDO_BLOCKS window + 6):
// the decoder aborts reorg recovery past that depth, so an XCHAIN_UNDO_BLOCKS_<COIN>
// env override that raises a chain's tracker window above this ceiling silently
// splits the two components' effective reorg windows. Raising either constant
// requires raising both, in lockstep.
const MAX_SAFE_UNDO_BLOCKS = 126

// Map a network string ('bitcoin-mainnet', 'dogecoin-regtest', ...) to a coin
// tick, THROUGH the canonical registry (item 5803). A hardcoded coin-name list
// stood here and returned null for anything it did not name, which made the
// caller's own promise false: XChainUtxoTracker's constructor says the auxPow
// decision "comes from the coin's declared wireFormat in the canonical registry
// ... so onboarding a merge-mined chain is a registry edit", and a registry-only
// edit resolved to null, WIRE_FORMAT[null] to undefined, and auxPow to false -
// merged-mined headers parsed as plain Bitcoin ones. Same lookup as
// CryptoNetworks.js and bulk-sync/dump.js, so the tracker has one name->tick
// table and not three. Returns null for a name no registered coin claims;
// resolveUndoBlocks below is what refuses it.
function coinFromNetwork(network){
    const n = String(network || '').toLowerCase()
    const i = n.lastIndexOf('-')
    // A bare full name with no '-<net>' suffix is accepted, as the prefix match
    // this replaced was.
    const full = i < 0 ? n : n.slice(0, i)
    return coins.FULL_NAME_TO_TICK[full] || null
}

// Net portion ('mainnet'|'testnet'|'regtest') of a '<fullname>-<net>' key. A
// bare name with no suffix is accepted by coinFromNetwork above and resolves
// here to '', which names no table entry, so resolveUndoBlocks refuses it: a
// network that does not say which net it is cannot be handed a window that
// differs by net.
function netFromNetwork(network){
    const n = String(network || '').toLowerCase()
    const i = n.lastIndexOf('-')
    return i < 0 ? '' : n.slice(i + 1)
}

// The DEFAULT_UNDO_BLOCKS key for a (tick, net) pair, e.g. 'BTC_TESTNET'.
function undoBlocksKey(coin, net){
    return coin + '_' + net.toUpperCase()
}

// SINGLE-SOURCED env-override resolver, shared by the live worker
// (XChainUtxoTracker.js), the bulk seeder (derive-keys.js), the orchestrator,
// and api.js. Two hand-coded copies had diverged: the live one honored a
// non-positive override via `parseInt(...) || default` (a negative value is
// truthy, so `XCHAIN_UNDO_BLOCKS_DOGE=-5` yielded -5 and degenerated the aging
// loop into a mass K/M-undo purge), while the seeder rejected it via `> 0`,
// letting the seeded N-window drift from the live undo window under the identical
// env. This single resolver rejects non-positive/non-integer overrides (falls
// back to the per-network default) and applies the MAX_SAFE warning uniformly.
// Resolution order: explicit optsUndoBlocks → positive env override →
// per-coin, per-network default. There is no global fallback: an unresolvable
// chain THROWS (item 5803). A silent fallback of 12 is sized for 10-minute BTC
// blocks, and the chains that reach this path unresolved are the newly onboarded
// ones, so that default is systematically wrong in the unsafe direction.
//
// The override stays XCHAIN_UNDO_BLOCKS_<COIN>, with no network-qualified
// XCHAIN_UNDO_BLOCKS_<COIN>_<NET> beside it. A tracker process serves exactly
// one network and reads the env of that one deployment (xchain-node writes a
// compose file per coin and net), so the coin-only key already names one
// (coin, net) pair and a second key would only give the two a way to disagree.
// The same call was made for XCHAIN_COINBASE_MATURITY in coinbase_maturity.js.
function resolveUndoBlocks(network, optsUndoBlocks){
    const coin = coinFromNetwork(network)
    const net = netFromNetwork(network)
    // Both refusals run BEFORE the override branches: an explicit opts value or
    // an env override must not let an unregistered chain, or a registered chain
    // with no declared window, past this point wearing a plausible number.
    if (!coin) {
        throw new Error(
            'undo-blocks: network "' + network + '" names no coin in the canonical registry (src/coins), ' +
            'so no per-chain reorg-recovery window can be resolved for it. Check the configured network name.')
    }
    const key = undoBlocksKey(coin, net)
    if (!Number.isInteger(DEFAULT_UNDO_BLOCKS[key])) {
        throw new Error(
            'undo-blocks: coin ' + coin + ' (network "' + network + '") is registered in src/coins but has no ' +
            'reorg-recovery window for net "' + net + '". Add DEFAULT_UNDO_BLOCKS.' + key + ' in ' +
            'src/chain/undo_blocks.js, sized from that chain\'s block time on mainnet and from its ' +
            'minimum-difficulty fork depth on testnet, before onboarding it.')
    }
    const fallback = DEFAULT_UNDO_BLOCKS[key]
    // Whole-string read (src/config/env_int.js), never parseInt: parseInt reads a numeric
    // PREFIX, so the isInteger guard below inspected an already-truncated number
    // and could not refuse anything. '1.5' resolved to 1 and '12garbage' to 12,
    // shortening the recovery window on the live worker, the seeder, the tip-safety
    // clamp, dump windowing and the api pre-flight at once (item 7714). A malformed
    // override now warns and leaves the per-network default standing.
    const envKey = 'XCHAIN_UNDO_BLOCKS_' + coin
    const envVal = envInt(envKey, fallback, 1,
        'The per-chain reorg-recovery window default stands.')
    let resolved
    if (Number.isInteger(optsUndoBlocks) && optsUndoBlocks > 0) {
        resolved = optsUndoBlocks
    } else if (Number.isInteger(envVal) && envVal > 0) {
        resolved = envVal
    } else {
        resolved = fallback
    }
    // Loud warning (do NOT clamp or throw: the override is a deliberate operator
    // knob) when the resolved window exceeds the decoder's dispenser-expiry safe
    // depth. Past that ceiling the decoder aborts reorg recovery while the tracker
    // keeps auto-recovering, silently splitting the two effective reorg windows.
    if (resolved > MAX_SAFE_UNDO_BLOCKS) {
        logger.error(
            'WARNING: resolved undo-blocks window for ' + coin + ' (' + network + ') is ' + resolved +
            ', which exceeds the decoder dispenser-expiry safe depth (' + MAX_SAFE_UNDO_BLOCKS + '). ' +
            'The decoder will abort reorg recovery past ' + MAX_SAFE_UNDO_BLOCKS + ' blocks while this ' +
            'tracker auto-recovers, splitting the two effective reorg windows. Raise ' +
            'DISPENSER_EXPIRE_SAFE_DEPTH in the decoder to match, or lower ' + envKey + '.'
        )
    }
    return resolved
}

module.exports = { DEFAULT_UNDO_BLOCKS, MAX_SAFE_UNDO_BLOCKS, coinFromNetwork, netFromNetwork, undoBlocksKey, resolveUndoBlocks }
