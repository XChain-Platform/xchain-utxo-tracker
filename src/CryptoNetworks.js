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
 * XChain UTXO Tracker - Crypto Networks Class
 *
 * Thin adapter over the canonical coin registry (src/coins). The tracker only
 * needs the bitcoinjs network object (address coding); it builds no transactions,
 * so the relay-only fields it now inherits from canonical (e.g.
 * singleOpReturnPolicy) are unused here. THROWS on an unknown network name,
 * matching the xchain-decoder and xchain-encoder twins (item 5879). The previous
 * `undefined` return made safety a property of every caller remembering to check
 * it, and bitcoinjs-lib treats an undefined network object as BTC mainnet, so the
 * first caller to forget would decode addresses and scripts under the wrong
 * chain's parameters rather than fail.
 *
 ********************************************************************/

const coins = require('./coins');

const SUPPORTED = 'bitcoin-mainnet, bitcoin-testnet, bitcoin-regtest, dogecoin-mainnet, ' +
    'dogecoin-testnet, dogecoin-regtest, litecoin-mainnet, litecoin-testnet, litecoin-regtest';

// Split a "<fullname>-<network>" key (e.g. "bitcoin-mainnet") into a canonical
// {tick, net} pair, or null when it names no known coin/network. Same shape as
// the decoder twin, so the two files stay textually comparable.
function parseNetworkName(networkName){
    const s = String(networkName);
    const i = s.lastIndexOf('-');
    if(i < 0) return null;
    const tick = coins.FULL_NAME_TO_TICK[s.slice(0, i)];
    const net  = s.slice(i + 1);
    if(!tick || !coins.NETWORKS.includes(net)) return null;
    return { tick, net };
}

class CryptoNetworks {
    static getBitcoinJsNetwork(networkName){
        const p = parseNetworkName(networkName);
        if(!p) throw new TypeError(`Unknown network: "${networkName}". Supported: ${SUPPORTED}`);
        return coins.getCoinConfig(p.tick, p.net).net;
    }
}

module.exports = CryptoNetworks;
