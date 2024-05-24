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
		}
	}
}

module.exports = CryptoNetworks