/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 *
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided "AS IS", without warranties or conditions of any kind.
 *
 **********************************************************************
 *
 * XChain UTXO Tracker - Blockchain Connector Class
 *
 * This file handles pulling blockchain data from a coin daemon
 *
 ********************************************************************/

// Load required libraries
const axios = require('axios');
const http  = require('http');

class BlockchainConnector {
    constructor(url, port, rpcUser, rpcPassword) {
        this.url = "http://"+url+":"+port
        this.port = port
        this.rpcUser = rpcUser
        this.rpcPassword = rpcPassword

        // Reuse TCP connections across all RPC calls and authenticate once per instance
        this.client = axios.create({
            timeout: parseInt(process.env.NODE_RPC_TIMEOUT ?? '30000', 10),
            httpAgent: new http.Agent({ keepAlive: true, maxSockets: 25 }),
            auth: { username: rpcUser, password: rpcPassword }
        })
    }

    async sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async getNetworkInfo(){
        const data = {
            jsonrpc: '2.0',
            method: 'getnetworkinfo',
            id: 1
        }

        const response = await this.client.post(this.url, data)

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

        const response = await this.client.post(this.url, data)

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

            const response = await this.client.post(this.url, data)

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

    async getBlockHeader(blockhash, hexFormat = true) {
        let tries = 10

        while (tries > 0) {
            try {
                const data = {
                    jsonrpc: '2.0',
                    method: 'getblockheader',
                    params: [blockhash, !hexFormat],
                    id: 1,
                }

                const response = await this.client.post(this.url, data)

                if (response.data.result) {
                    return response.data.result;
                } else {
                    throw new Error('Error getting block hex');
                }
            } catch (error) {
                if (error.code === 'ECONNABORTED') {
                    tries = tries - 1
                    console.log("Getting timeout trying to get block hex, trying again...")
                    //Do nothing, let the while to try again
                } else {
                    console.error('Error:', error);
                    throw error;
                }
            }
        }

        throw new Error("There were problems getting a block hex. ")
    }

    async getBlockWithoutAuxPow(blockhash) {
        try {
            let blockHeaderHex = await this.getBlockHeader(blockhash, true)
            let blockHex = await this.getBlock(blockhash, true)

		let dataToRemove = blockHeaderHex.length - 160 //80 bytes of bitcoin block header

            if (dataToRemove > 0) {
                blockHex = blockHex.substring(0,160)+blockHex.substring(160+dataToRemove)
            }

            return blockHex
        } catch (err) {
            throw new Error("There were problems getting a block hex without auxpow. ")
        }
    }

    async getRawMempool(){
        try {
            const data = {
                jsonrpc: '2.0',
                method: 'getrawmempool',
                id: 1
            }

            const response = await this.client.post(this.url, data)

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

            const response = await this.client.post(this.url, data)

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
        return new Promise(async (resolve, reject) => {
            let maxTries = 10
            let tries = 0
            while (tries < maxTries){
                tries++
                try {
                    const data = {
                        jsonrpc: '2.0',
                        method: 'getrawtransaction',
                        params: [txid],
                        id: 1
                    }

                    const response = await this.client.post(this.url, data)

                    if (response.data.result) {
                        resolve(response.data.result);
                        break
                    } else {
                        // Tx no longer in mempool (mined/evicted between getRawMempool and this call) — caller filters nulls
                        resolve(null);
                        break
                    }
                } catch (error){
                    await this.sleep(500)
                }
            }

            if (tries >= maxTries){
                reject(null)
            }
        })
    }

    async getRawTransactions(txIdArray){
        let requests = []

        for (let nextTxIdIndex in txIdArray){
            let nextTxId = txIdArray[nextTxIdIndex]

            requests.push(this.getRawTransaction(nextTxId))
        }

        return Promise.all(requests)
    }

    async getBlock(blockhash, hexFormat=true) {
        try {
            const data = {
                jsonrpc: '2.0',
                method: 'getblock',
                params: [blockhash, !hexFormat],
                id: 1,
            }

            const response = await this.client.post(this.url, data)

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

    // Fetch multiple blocks in two batched JSON-RPC requests instead of 2×N individual ones:
    //   Request 1: batch getblockhash for all heights  → N hashes
    //   Request 2: batch getblock for all hashes       → N block hexes
    // Returns array of { height, hash, hex } in the same order as `heights`.
    async getBlocksBatch(heights) {
        if (heights.length === 0) return []

        // Batch 1: all getblockhash calls in one HTTP request
        const hashBatch = heights.map((h, i) => ({
            jsonrpc: '2.0',
            method: 'getblockhash',
            params: [h],
            id: i
        }))
        const hashResponse = await this.client.post(this.url, hashBatch)
        const hashResults  = hashResponse.data.sort((a, b) => a.id - b.id)
        const hashes = hashResults.map(r => {
            if (!r.result) throw new Error('Error getting block hash in batch for id ' + r.id)
            return r.result
        })

        // Batch 2: all getblock calls in one HTTP request
        const blockBatch = hashes.map((hash, i) => ({
            jsonrpc: '2.0',
            method: 'getblock',
            params: [hash, false],  // false = hex format
            id: i
        }))
        const blockResponse = await this.client.post(this.url, blockBatch)
        const blockResults  = blockResponse.data.sort((a, b) => a.id - b.id)

        return heights.map((h, i) => ({
            height: h,
            hash:   hashes[i],
            hex:    blockResults[i].result
        }))
    }

    // Like getBlocksBatch, but strips AuxPoW data from each block hex using a third
    // batched getblockheader call. Use this for AuxPoW chains (e.g. Dogecoin) where the
    // raw block hex contains AuxPoW bytes between the 80-byte header and the tx count
    // varint, which would break bitcoinjs-lib's Block.fromBuffer.
    async getBlocksBatchWithoutAuxPow(heights) {
        if (heights.length === 0) return []

        // Batch 1: all getblockhash calls
        const hashBatch = heights.map((h, i) => ({
            jsonrpc: '2.0',
            method: 'getblockhash',
            params: [h],
            id: i
        }))
        const hashResponse = await this.client.post(this.url, hashBatch)
        const hashes = hashResponse.data.sort((a, b) => a.id - b.id).map(r => {
            if (!r.result) throw new Error('Error getting block hash in batch for id ' + r.id)
            return r.result
        })

        // Batch 2: all getblockheader calls (hex format) — needed to compute AuxPoW size
        const headerBatch = hashes.map((hash, i) => ({
            jsonrpc: '2.0',
            method: 'getblockheader',
            params: [hash, false],  // false = hex format
            id: i
        }))
        const headerResponse = await this.client.post(this.url, headerBatch)
        const headers = headerResponse.data.sort((a, b) => a.id - b.id).map(r => {
            if (!r.result) throw new Error('Error getting block header in batch for id ' + r.id)
            return r.result
        })

        // Batch 3: all getblock calls (hex format)
        const blockBatch = hashes.map((hash, i) => ({
            jsonrpc: '2.0',
            method: 'getblock',
            params: [hash, false],
            id: i
        }))
        const blockResponse = await this.client.post(this.url, blockBatch)
        const blocks = blockResponse.data.sort((a, b) => a.id - b.id).map(r => {
            if (!r.result) throw new Error('Error getting block in batch for id ' + r.id)
            return r.result
        })

        return heights.map((h, i) => {
            const headerHex = headers[i]
            let blockHex    = blocks[i]
            const dataToRemove = headerHex.length - 160  // 160 hex chars = 80-byte standard header
            if (dataToRemove > 0) {
                blockHex = blockHex.substring(0, 160) + blockHex.substring(160 + dataToRemove)
            }
            return {
                height: h,
                hash:   hashes[i],
                hex:    blockHex
            }
        })
    }
}

module.exports = BlockchainConnector
