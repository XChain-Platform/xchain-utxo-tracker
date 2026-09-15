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
 **********************************************************************/

const { orderBatchResults } = require('./rpc_helpers');
const { stripAuxPowFromBlockHex } = require('./auxpow_codec');

async function getBatchHashes(heights) {
    // Batch 1: all getblockhash calls
    const hashBatch = heights.map((h, i) => ({
        jsonrpc: '2.0',
        method: 'getblockhash',
        params: [h],
        id: i
    }))
    const hashResponse = await this.postWithRetry(hashBatch)
    const hashes = orderBatchResults(hashResponse.data, heights.length, 'getblockhash').map(r => {
        if (!r.result) throw new Error('Error getting block hash in batch for id ' + r.id)
        return r.result
    })
    return hashes
}

async function getBatchHeaders(hashes) {
    // Batch 2: all getblockheader calls (hex format), needed to compute AuxPoW size
    const headerBatch = hashes.map((hash, i) => ({
        jsonrpc: '2.0',
        method: 'getblockheader',
        params: [hash, false],  // false = hex format (Dogecoin 1.14 getblockheader expects a boolean verbose, not an integer verbosity)
        id: i
    }))
    const headerResponse = await this.postWithRetry(headerBatch)
    const headers = orderBatchResults(headerResponse.data, hashes.length, 'getblockheader').map(r => {
        if (!r.result) throw new Error('Error getting block header in batch for id ' + r.id)
        return r.result
    })
    return headers
}

async function getBatchBlocks(hashes) {
    // Batch 3: all getblock calls (hex format)
    const blockBatch = hashes.map((hash, i) => ({
        jsonrpc: '2.0',
        method: 'getblock',
        params: [hash, false],  // false = hex format; Dogecoin 1.14 getblock expects a boolean verbose, not integer verbosity
        id: i
    }))
    const blockResponse = await this.postWithRetry(blockBatch)
    const blocks = orderBatchResults(blockResponse.data, hashes.length, 'getblock').map(r => {
        if (!r.result) throw new Error('Error getting block in batch for id ' + r.id)
        return r.result
    })
    return blocks
}

module.exports = {
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
        const hashResults  = orderBatchResults(hashResponse.data, heights.length, 'getblockhash')
        const hashes = hashResults.map(r => {
            if (!r.result) throw new Error('Error getting block hash in batch for id ' + r.id)
            return r.result
        })

        // Batch 2: all getblock calls in one HTTP request
        const blockBatch = hashes.map((hash, i) => ({
            jsonrpc: '2.0',
            method: 'getblock',
            params: [hash, false],  // false = hex format; Dogecoin 1.14 getblock expects a boolean verbose, not integer verbosity
            id: i
        }))
        const blockResponse = await this.postWithRetry(blockBatch)
        const blockResults  = orderBatchResults(blockResponse.data, hashes.length, 'getblock')

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
    },

    // Like getBlocksBatch, but strips AuxPoW data from each block hex using a third
    // batched getblockheader call. Use this for AuxPoW chains (e.g. Dogecoin) where the
    // raw block hex contains AuxPoW bytes between the 80-byte header and the tx count
    // varint, which would break bitcoinjs-lib's Block.fromBuffer.
    async getBlocksBatchWithoutAuxPow(heights) {
        if (heights.length === 0) return []

        const hashes = await getBatchHashes.call(this, heights)
        const headers = await getBatchHeaders.call(this, hashes)
        const blocks = await getBatchBlocks.call(this, hashes)

        // Only the strip is wrapped, for the reason given on getBlockWithoutAuxPow: the
        // three postWithRetry batches and their !r.result guards above are transport and
        // must stay untagged. This path matters more than the single-block one on an
        // AuxPoW chain - the prefetch queue is the tracker's normal block source, so a
        // genuinely malformed block fails HERE, and an untagged failure here would leave
        // the malformed-AuxPoW reassembly recovery unable to fire at all.
        return heights.map((h, i) => {
            const headerHex = headers[i]
            let blockHex    = blocks[i]

            try {
                blockHex = stripAuxPowFromBlockHex(headerHex, blockHex)
            } catch (err) {
                const parseErr = new Error('There were problems stripping auxpow from block ' + h +
                    ' (' + hashes[i] + ') in batch. ' + err.message)
                parseErr.auxPowParseFailure = true
                parseErr.cause = err
                throw parseErr
            }

            return {
                height: h,
                hash:   hashes[i],
                hex:    blockHex
            }
        })
    }
}
