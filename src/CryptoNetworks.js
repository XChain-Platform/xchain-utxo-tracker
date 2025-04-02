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
        }
    }
}

module.exports = CryptoNetworks