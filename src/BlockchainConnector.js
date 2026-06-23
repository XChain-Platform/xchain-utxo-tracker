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
 * XChain UTXO Tracker - Blockchain Connector Class
 *
 * This file handles pulling blockchain data from a coin daemon
 *
 ********************************************************************/

// Load required libraries
const axios = require('axios');
const http  = require('http');

// Decode a Bitcoin-style varint from `buf` at `offset`.
// Returns { value, bytes } where `bytes` is the number of bytes consumed.
function readVarint(buf, offset) {
    const first = buf[offset]
    if (first < 0xFD) return { value: first, bytes: 1 }
    if (first === 0xFD) return { value: buf.readUInt16LE(offset + 1), bytes: 3 }
    if (first === 0xFE) return { value: buf.readUInt32LE(offset + 1), bytes: 5 }
    // 0xFF: 8-byte varint; safe for our sizes (branch counts are small)
    const lo = buf.readUInt32LE(offset + 1)
    const hi = buf.readUInt32LE(offset + 5)
    return { value: hi * 0x100000000 + lo, bytes: 9 }
}

// Parse the AuxPoW section from a raw block Buffer starting at byte offset `start`
// (immediately after the 80-byte standard header). Returns the byte offset of the
// first byte after the AuxPoW section (i.e. where the tx-count varint begins).
// AuxPoW layout: coinbase tx | parent block hash (32 B) |
//                coinbase merkle branch (varint count + count*32 B + 4 B index) |
//                chain merge-mining branch (same layout) |
//                parent block header (80 B)
// Throws if the buffer is too short or structurally invalid.
function skipAuxPow(buf, start) {
    let offset = start

    // Skip the coinbase transaction (a full serialized Bitcoin tx).
    // version (4) | [segwit marker+flag (2, optional)] | inputs | outputs | [witness] | locktime (4)
    if (offset + 4 > buf.length) throw new Error('AuxPoW parse: buffer too short for coinbase version')
    offset += 4  // version

    // Detect SegWit marker (0x00 flag byte means segwit)
    const hasSegwit = (buf[offset] === 0x00)
    if (hasSegwit) offset += 2  // skip marker + flag

    // Inputs
    const insVI = readVarint(buf, offset)
    offset += insVI.bytes
    const nIns = insVI.value
    for (let i = 0; i < nIns; i++) {
        if (offset + 36 > buf.length) throw new Error('AuxPoW parse: buffer too short for coinbase input prevout')
        offset += 36  // prev hash (32) + prev index (4)
        const scriptVI = readVarint(buf, offset)
        offset += scriptVI.bytes + scriptVI.value  // script length + script bytes
        if (offset + 4 > buf.length) throw new Error('AuxPoW parse: buffer too short for coinbase input sequence')
        offset += 4  // sequence
    }

    // Outputs
    const outsVI = readVarint(buf, offset)
    offset += outsVI.bytes
    const nOuts = outsVI.value
    for (let i = 0; i < nOuts; i++) {
        if (offset + 8 > buf.length) throw new Error('AuxPoW parse: buffer too short for coinbase output value')
        offset += 8  // value (8 bytes)
        const scriptVI = readVarint(buf, offset)
        offset += scriptVI.bytes + scriptVI.value
    }

    // Witness data (only if segwit coinbase)
    if (hasSegwit) {
        for (let i = 0; i < nIns; i++) {
            const stackVI = readVarint(buf, offset)
            offset += stackVI.bytes
            const stackItems = stackVI.value
            for (let j = 0; j < stackItems; j++) {
                const itemVI = readVarint(buf, offset)
                offset += itemVI.bytes + itemVI.value
            }
        }
    }

    if (offset + 4 > buf.length) throw new Error('AuxPoW parse: buffer too short for coinbase locktime')
    offset += 4  // locktime

    // Parent block hash (32 bytes)
    if (offset + 32 > buf.length) throw new Error('AuxPoW parse: buffer too short for parent block hash')
    offset += 32

    // Coinbase merkle branch: varint count, count*32 B hashes, 4 B index
    const cbVI = readVarint(buf, offset)
    offset += cbVI.bytes
    if (offset + cbVI.value * 32 + 4 > buf.length) throw new Error('AuxPoW parse: buffer too short for coinbase branch')
    offset += cbVI.value * 32 + 4

    // Chain merge-mining branch: same layout
    const chainVI = readVarint(buf, offset)
    offset += chainVI.bytes
    if (offset + chainVI.value * 32 + 4 > buf.length) throw new Error('AuxPoW parse: buffer too short for chain branch')
    offset += chainVI.value * 32 + 4

    // Parent block header (80 bytes)
    if (offset + 80 > buf.length) throw new Error('AuxPoW parse: buffer too short for parent block header')
    offset += 80

    return offset
}

// Strip the AuxPoW section from a merge-mined block's hex, preserving the 80-byte
// (160 hex char) standard header. Two daemon behaviors are handled: an older daemon
// whose getblockheader already includes the AuxPoW bytes (length-based strip via the
// header/block length delta), and Dogecoin Core 1.14 whose getblockheader always
// returns exactly 160 chars, requiring the AuxPoW size to be parsed structurally from
// the block hex (skipAuxPow). Non-AuxPoW blocks pass through unchanged. Shared by the
// single-block (getBlockWithoutAuxPow) and batch (getBlocksBatchWithoutAuxPow) paths
// so a strip correction can never land in one and silently miss the other.
function stripAuxPowFromBlockHex(headerHex, blockHex) {
    const dataToRemove = headerHex.length - 160  // 160 hex chars = 80-byte standard header
    if (dataToRemove > 0) {
        // Legacy path: getblockheader included AuxPoW bytes (older daemon).
        return blockHex.substring(0, 160) + blockHex.substring(160 + dataToRemove)
    }
    if (blockHex.length >= 8) {
        const versionLE = parseInt(blockHex.substring(0, 8), 16)
        const version = ((versionLE & 0xFF) << 24) | (((versionLE >> 8) & 0xFF) << 16) |
                        (((versionLE >> 16) & 0xFF) << 8) | ((versionLE >> 24) & 0xFF)
        if (version & 0x100) {
            // AuxPoW version bit set but getblockheader returned no extra bytes
            // (Dogecoin Core 1.14). Parse the AuxPoW size from the block hex directly.
            const blockBuf = Buffer.from(blockHex, 'hex')
            const afterAuxPow = skipAuxPow(blockBuf, 80)
            return blockHex.substring(0, 160) + blockHex.substring(afterAuxPow * 2)
        }
    }
    return blockHex
}

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
                    params: [blockhash, !hexFormat],  // getblockheader verbose is a boolean (false=hex, true=json); Dogecoin 1.14 rejects integer verbosity
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
                    // Back off 500ms between attempts so a persistently-flapping node is
                    // not hot-spun through all 10 tries near-instantly; matches the
                    // postWithRetry / getBlock retry cadence.
                    if (tries > 0) await this.sleep(500)
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

            // Dogecoin Core 1.14.x getblockheader always returns the pure 80-byte header
            // (160 hex chars) regardless of whether the block is merge-mined. When the
            // header is longer than 160 chars the legacy path (length-based strip) works;
            // when it is exactly 160 chars and the AuxPoW version bit (0x100) is set we
            // must parse the AuxPoW size from the block hex itself to find where the
            // AuxPoW section ends and the tx-count varint begins.
            blockHex = stripAuxPowFromBlockHex(blockHeaderHex, blockHex)

            return blockHex
        } catch (err) {
            throw new Error("There were problems getting a block hex without auxpow. " + err.message)
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
                        // Tx no longer in mempool (mined/evicted between getRawMempool and this call): caller filters nulls
                        resolve(null);
                        break
                    }
                } catch (error){
                    await this.sleep(500)
                }
            }

            if (tries >= maxTries){
                reject(new Error('getRawTransaction: exhausted retries for ' + txid))
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
                params: [blockhash, hexFormat ? 0 : 1],
                id: 1,
            }

            // Route through postWithRetry (10 ECONNABORTED retries) to match getBlockHeader.
            // getBlockWithoutAuxPow chains getBlockHeader -> getBlock on the Dogecoin AuxPoW
            // path; without retry here a transient timeout in this leg discards an already-
            // successful header fetch and forces the caller to redo the whole operation.
            const response = await this.postWithRetry(data)

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

    // POST a (batched) JSON-RPC payload, retrying on transient connection timeouts.
    // Mirrors the ECONNABORTED retry loop in getBlockHeader: up to 10 attempts with a
    // short backoff. The batch methods route every .post() through here so a single
    // transient timeout doesn't throw away the whole batch window; without this, one
    // flaky request evicts all prefetched heights and forces slow single-block refetching.
    async postWithRetry(data) {
        let tries = 10

        while (tries > 0) {
            try {
                return await this.client.post(this.url, data)
            } catch (error) {
                if (error.code === 'ECONNABORTED') {
                    tries = tries - 1
                    console.log("Getting timeout on a batch RPC call, trying again...")
                    await this.sleep(500)
                } else {
                    console.error('Error:', error)
                    throw error
                }
            }
        }

        throw new Error("There were problems with a batch RPC call after retries. ")
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
        const hashResponse = await this.postWithRetry(hashBatch)
        const hashResults  = hashResponse.data.sort((a, b) => a.id - b.id)
        const hashes = hashResults.map(r => {
            if (!r.result) throw new Error('Error getting block hash in batch for id ' + r.id)
            return r.result
        })

        // Batch 2: all getblock calls in one HTTP request
        const blockBatch = hashes.map((hash, i) => ({
            jsonrpc: '2.0',
            method: 'getblock',
            params: [hash, 0],  // 0 = hex format
            id: i
        }))
        const blockResponse = await this.postWithRetry(blockBatch)
        const blockResults  = blockResponse.data.sort((a, b) => a.id - b.id)

        // Guard matches the hash batch above and the AuxPoW path: a JSON-RPC error
        // element returns result=null and would produce hex:undefined, causing an
        // opaque decode failure later instead of a clear error here.
        return heights.map((h, i) => {
            if (!blockResults[i].result) throw new Error('Error getting block in batch for id ' + blockResults[i].id)
            return {
                height: h,
                hash:   hashes[i],
                hex:    blockResults[i].result
            }
        })
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
        const hashResponse = await this.postWithRetry(hashBatch)
        const hashes = hashResponse.data.sort((a, b) => a.id - b.id).map(r => {
            if (!r.result) throw new Error('Error getting block hash in batch for id ' + r.id)
            return r.result
        })

        // Batch 2: all getblockheader calls (hex format), needed to compute AuxPoW size
        const headerBatch = hashes.map((hash, i) => ({
            jsonrpc: '2.0',
            method: 'getblockheader',
            params: [hash, false],  // false = hex format (Dogecoin 1.14 getblockheader expects a boolean verbose, not an integer verbosity)
            id: i
        }))
        const headerResponse = await this.postWithRetry(headerBatch)
        const headers = headerResponse.data.sort((a, b) => a.id - b.id).map(r => {
            if (!r.result) throw new Error('Error getting block header in batch for id ' + r.id)
            return r.result
        })

        // Batch 3: all getblock calls (hex format)
        const blockBatch = hashes.map((hash, i) => ({
            jsonrpc: '2.0',
            method: 'getblock',
            params: [hash, 0],  // 0 = hex format
            id: i
        }))
        const blockResponse = await this.postWithRetry(blockBatch)
        const blocks = blockResponse.data.sort((a, b) => a.id - b.id).map(r => {
            if (!r.result) throw new Error('Error getting block in batch for id ' + r.id)
            return r.result
        })

        return heights.map((h, i) => {
            const headerHex = headers[i]
            let blockHex    = blocks[i]

            blockHex = stripAuxPowFromBlockHex(headerHex, blockHex)

            return {
                height: h,
                hash:   hashes[i],
                hex:    blockHex
            }
        })
    }
}

module.exports = BlockchainConnector
