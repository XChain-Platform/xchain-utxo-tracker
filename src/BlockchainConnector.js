const axios = require('axios');
axios.defaults.timeout = 5000

class BlockchainConnector {
	constructor(url, rpcUser, rpcPassword) {
		this.url = url
		this.rpcUser = rpcUser
		this.rpcPassword = rpcPassword
	}

	async getNetworkInfo(){
		const data = {
			jsonrpc: '2.0',
			method: 'getnetworkinfo',
			id: 1
		}
		
		// Make the request to the node
		const response = await axios.post(this.url, data, {
			auth: {
				username: this.rpcUser,
				password: this.rpcPassword,
			}
		})

		// Verify if there is a result and return it
		if (response.data.result) {
			return response.data.result;
		} else {
			throw new Error('Error getting network info');
		}
	}
	
	async getBlockchainInfo(){
		const data = {
			jsonrpc: '2.0',
			method: 'getblockchaininfo',
			id: 1
		}
		
		// Make the request to the node
		const response = await axios.post(this.url, data, {
			auth: {
				username: this.rpcUser,
				password: this.rpcPassword,
			}
		})

		// Verify if there is a result and return it
		if (response.data.result) {
			return response.data.result;
		} else {
			throw new Error('Error getting blockchain info');
		}
	}

	async getBlockHash(blockindex) {
		try {
			const data = {
				jsonrpc: '2.0',
				method: 'getblockhash',
				params: [blockindex],
				id: 1,
			}

			// Make the request to the node
			const response = await axios.post(this.url, data, {
				auth: {
					username: this.rpcUser,
					password: this.rpcPassword,
				}
			})

			// Verify if there is a result and return it
			if (response.data.result) {
				return response.data.result;
			} else {
				throw new Error('Error getting block hash');
			}
		} catch (error) {
			console.error('Error:', error.message);
			throw error;
		}
	}

	async getBlock(blockhash, hexFormat=true) {
		try {
			const data = {
				jsonrpc: '2.0',
				method: 'getblock',
				params: [blockhash, (hexFormat?0:1)],
				id: 1,
			}

			// Make the request to the node
			const response = await axios.post(this.url, data, {
				auth: {
					username: this.rpcUser,
					password: this.rpcPassword,
				}
			})

			// Verify if there is a result and return it
			if (response.data.result) {
				return response.data.result;
			} else {
				throw new Error('Error getting block hex');
			}
		} catch (error) {
			console.error('Error:', error.message);
			throw error;
		}
	}
	
	async getRawMempool(){
		try {
			const data = {
				jsonrpc: '2.0',
				method: 'getrawmempool',
				id: 1
			}
			
			// Make the request to the node
			const response = await axios.post(this.url, data, {
				auth: {
					username: this.rpcUser,
					password: this.rpcPassword,
				}
			})

			// Verify if there is a result and return it
			if (response.data.result) {
				return response.data.result;
			} else {
				throw new Error('Error getting raw mempool info');
			}
		} catch (error){
			console.error('Error:', error.message);
			throw error;
		}
	}
	
	async getMempoolEntry(txid){
		try {
			const data = {
				jsonrpc: '2.0',
				method: 'getmempoolentry',
				params: [txid],
				id: 1
			}
			
			// Make the request to the node
			const response = await axios.post(this.url, data, {
				auth: {
					username: this.rpcUser,
					password: this.rpcPassword,
				}
			})

			// Verify if there is a result and return it
			if (response.data.result) {
				return response.data.result;
			} else {
				throw new Error('Error getting mempool entry');
			}
		} catch (error){
			console.error('Error:', error.message);
			throw error;
		}
	}
	
	async getRawTransaction(txid){
		try {
			const data = {
				jsonrpc: '2.0',
				method: 'getrawtransaction',
				params: [txid],
				id: 1
			}
			
			// Make the request to the node
			const response = await axios.post(this.url, data, {
				auth: {
					username: this.rpcUser,
					password: this.rpcPassword,
				}
			})

			// Verify if there is a result and return it
			if (response.data.result) {
				return response.data.result;
			} else {
				throw new Error('Error getting raw transaction');
			}
		} catch (error){
			return null
			//console.error('Error:', error.message);
			//throw error;
		}
	}
	
	async getBlock(blockhash, hexFormat=true) {
		try {
			const data = {
				jsonrpc: '2.0',
				method: 'getblock',
				params: [blockhash, (hexFormat?0:1)],
				id: 1,
			}

			// Make the request to the node
			const response = await axios.post(this.url, data, {
				auth: {
					username: this.rpcUser,
					password: this.rpcPassword,
				}
			})

			// Verify if there is a result and return it
			if (response.data.result) {
				return response.data.result;
			} else {
				throw new Error('Error getting block hex');
			}
		} catch (error) {
			console.error('Error:', error.message);
			throw error;
		}
	}
}

module.exports = BlockchainConnector