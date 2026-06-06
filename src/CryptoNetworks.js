/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain UTXO Tracker - Crypto Networks Class
 * 
 * This file handles getting a bitcoinJS config for a specific network
 * 
 ********************************************************************/

// Load required libraries
const bitcoin = require('bitcoinjs-lib');

class CryptoNetworks {
    static getBitcoinJsNetwork(networkName){
        switch(networkName){
            case "bitcoin-mainnet":
                return bitcoin.networks.bitcoin
            case "bitcoin-testnet":
                return bitcoin.networks.testnet         
            case "bitcoin-regtest":
                return bitcoin.networks.regtest
            case "dogecoin-mainnet":
                return {
                    "messagePrefix": '\x19Dogecoin Signed Message:\n',
                    "bip32": {
                       "public": 0x02facafd,
                       "private": 0x02fac398
                    },
                    "pubKeyHash": 0x1e,
                    "scriptHash": 0x16,
                    "wif": 0x9e,
                    "dustThreshold": 546
                }
            case "dogecoin-testnet":
                return {
                    "messagePrefix": '\x19Dogecoin Signed Message:\n',
                    "bip32": {
                       "public": 0x0432a9a8,
                       "private": 0x0432a243
                    },
                    "pubKeyHash": 0x71,
                    "scriptHash": 0xc4,
                    "wif": 0xf1,
                    "dustThreshold": 546
                }
            case "dogecoin-regtest":
                // Dogecoin v1.14.x regtest reuses Bitcoin-testnet prefixes
                // (pubKeyHash 0x6f, WIF 0xef, bip32 0x043587cf/0x04358394).
                // NOT Dogecoin-testnet prefixes (0x71/0xf1/etc.). Generating
                // or recognizing addresses with 0x71 makes the tracker reject
                // node-issued addresses with "no matching Script".
                return {
                    "messagePrefix": '\x19Dogecoin Signed Message:\n',
                    "bip32": {
                       "public": 0x043587cf,
                       "private": 0x04358394
                    },
                    "pubKeyHash": 0x6f,
                    "scriptHash": 0xc4,
                    "wif": 0xef,
                    "dustThreshold": 546
                }
            case "litecoin-mainnet":
                return {
                    "messagePrefix": '\x19Litecoin Signed Message:\n',
                    "bech32": 'ltc',
                    "bip32": {
                       "public": 0x019da462,
                       "private": 0x019d9cfe 
                    },
                    "pubKeyHash": 0x30,
                    "scriptHash": 0x32,
                    "wif": 0xb0,
                    "dustThreshold": 546
                }
            case "litecoin-testnet":
                return {
                    "messagePrefix": '\x19Litecoin Signed Message:\n',
                    "bech32": 'tltc',
                    "bip32": {
                       "public": 0x0436f6e1,
                       "private": 0x0436ef7d 
                    },
                    "pubKeyHash": 0x6f,
                    "scriptHash": 0xc4,
                    "wif": 0xef,
                    "dustThreshold": 546
                }
            case "litecoin-regtest":
                return {
                    "messagePrefix": '\x19Litecoin Signed Message:\n',
                    "bech32": 'rltc',
                    "bip32": {
                       "public": 0x0436f6e1,
                       "private": 0x0436ef7d 
                    },
                    "pubKeyHash": 0x6f,
                    "scriptHash": 0xc4,
                    "wif": 0xef,
                    "dustThreshold": 546
                }   
        }
    }
}

module.exports = CryptoNetworks