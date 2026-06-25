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
 * singleOpReturnPolicy) are unused here. Returns undefined for an unknown network
 * name, matching the prior no-default behavior.
 *
 ********************************************************************/

const coins = require('./coins');

class CryptoNetworks {
    static getBitcoinJsNetwork(networkName){
        const s = String(networkName);
        const i = s.lastIndexOf('-');
        if(i < 0) return undefined;
        const tick = coins.FULL_NAME_TO_TICK[s.slice(0, i)];
        const net  = s.slice(i + 1);
        if(!tick || !coins.NETWORKS.includes(net)) return undefined;
        return coins.getCoinConfig(tick, net).net;
    }
}

module.exports = CryptoNetworks;
