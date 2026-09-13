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

// Per-coin/network coinbase maturity: how many confirmations a coinbase output
// needs before any node will accept a spend of it. Resolved the same way the
// reorg-recovery window is (src/undo-blocks.js), through the canonical coin
// registry, because it is the same class of value: a per-chain consensus
// constant that a single flat default gets wrong in the unsafe direction.
//
// It WAS a flat 100 for every chain, with a comment asserting "consensus rule:
// 100 on BTC/LTC/DOGE". That is true for BTC and LTC and false for DOGE, so a
// DOGE coinbase between 100 and 239 confirmations was served to callers as
// spendable and the encoder could fund a PSBT with an input Dogecoin rejects as
// immature.
const { coinFromNetwork } = require('./undo-blocks.js')
// The one strict numeric env reader (see src/env-int.js for why parseInt is not it).
const { envInt } = require('./env-int')

// Values are the chain's CURRENT rule at the tip, since that is what the node
// this tracker talks to enforces on a spend it is asked to relay today.
//
// BTC/LTC: Bitcoin Core and Litecoin Core both compile COINBASE_MATURITY = 100
// as a single constant in consensus/consensus.h, on every network including
// regtest.
//
// DOGE: Dogecoin Core v1.14.9 src/chainparams.cpp carries nCoinbaseMaturity per
// consensus epoch, not one value per chain. Mainnet and testnet both start at 30
// and move to 240 in the Digishield epoch (height 145000), which every live
// chain is far past, so 240 is the value at the tip. Regtest is a flat 60
// ("for easier testability in RPC tests"), which is LOWER than the old flat 100:
// the tracker was withholding mature DOGE regtest coinbase, harmlessly but
// wrongly, and a harness that mines exactly to depth deserves the real number.
const DEFAULT_COINBASE_MATURITY = {
    BTC:  { mainnet: 100, testnet: 100, regtest: 100 },
    LTC:  { mainnet: 100, testnet: 100, regtest: 100 },
    DOGE: { mainnet: 240, testnet: 240, regtest:  60 }
}

// Net portion ('mainnet'|'testnet'|'regtest') of a '<fullname>-<net>' key. A
// bare name with no suffix is accepted the same way coinFromNetwork accepts it,
// and resolves to no table entry, which resolveCoinbaseMaturity refuses.
function netFromNetwork(network){
    const n = String(network || '').toLowerCase()
    const i = n.lastIndexOf('-')
    return i < 0 ? '' : n.slice(i + 1)
}

// Resolution order: explicit opts value -> positive integer env override ->
// per-coin/network default -> throw. There is NO generic fallback, deliberately:
// a silent 100 is the exact bug this module replaces, and it fails in the unsafe
// direction (it under-states maturity, so the tracker serves an input the node
// will reject). A chain nobody has looked up the number for must halt the
// tracker at construction, not serve a plausible guess.
//
// XCHAIN_COINBASE_MATURITY stays a single un-suffixed var, unlike the per-coin
// XCHAIN_UNDO_BLOCKS_<COIN>: a tracker process serves exactly one network, so
// there is nothing for a suffix to disambiguate here. Non-positive and
// non-integer values fall back to the resolved default rather than through, so a
// typo cannot degenerate the gate.
function resolveCoinbaseMaturity(network, optsMaturity){
    const coin = coinFromNetwork(network)
    const net = netFromNetwork(network)
    // Both refusals run BEFORE the override branches, matching resolveUndoBlocks:
    // an explicit opts value or an env override must not let an unresolvable
    // chain past this point wearing a plausible number.
    if (!coin) {
        throw new Error(
            'coinbase-maturity: network "' + network + '" names no coin in the canonical registry (src/coins), ' +
            'so no per-chain coinbase maturity can be resolved for it. Check the configured network name.')
    }
    if (!DEFAULT_COINBASE_MATURITY[coin] || !Number.isInteger(DEFAULT_COINBASE_MATURITY[coin][net])) {
        throw new Error(
            'coinbase-maturity: coin ' + coin + ' (network "' + network + '") is registered in src/coins but has no ' +
            'declared coinbase maturity for net "' + net + '". Add one to DEFAULT_COINBASE_MATURITY in ' +
            'src/coinbase-maturity.js, read from that chain\'s own chainparams, before onboarding it.')
    }
    // Whole-string read, not parseInt, for the reason src/undo-blocks.js carries:
    // this knob had the identical prefix-truncation shape, so '1.5' resolved to a
    // maturity of 1 and served immature coinbase as spendable (item 7714's twin).
    const envVal = envInt('XCHAIN_COINBASE_MATURITY', DEFAULT_COINBASE_MATURITY[coin][net], 1,
        'The per-chain default coinbase maturity stands.')
    if (Number.isInteger(optsMaturity) && optsMaturity > 0) return optsMaturity
    if (Number.isInteger(envVal) && envVal > 0) return envVal
    return DEFAULT_COINBASE_MATURITY[coin][net]
}

module.exports = { DEFAULT_COINBASE_MATURITY, resolveCoinbaseMaturity }
