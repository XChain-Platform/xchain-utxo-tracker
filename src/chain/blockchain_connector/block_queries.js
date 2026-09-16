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

const util = require('node:util');
const { logger } = require('./constants');
const { sanitizeRpcError } = require('./rpc_helpers');
const { encodeVarintHex, stripAuxPowFromBlockHex } = require('./auxpow_codec');

module.exports = {
    async getBlockchainInfo(){
        const data = {
            jsonrpc: '2.0',
            method: 'getblockchaininfo',
            id: 1
        }

        let response
        try {
            response = await this.rpcPost(data)
        } catch (error) {
            // Scrub error.config.auth in place before it escapes: RPC calls carry
            // the node password in axios auth, and upstream sinks (the poll loop's
            // console.error(..., err)) would otherwise serialize it into the logs.
            // sanitizeRpcError mutates the error object, so even a raw rethrow is safe.
            sanitizeRpcError(error)
            throw error
        }

        if (response.data.result) {
            return response.data.result;
        } else {
            throw new Error('Error getting blockchain info');
        }
    },

    async getBlockHash(blockindex) {
        try {
            const data = {
                jsonrpc: '2.0',
                method: 'getblockhash',
                params: [blockindex],
                id: 1,
            }

            const response = await this.rpcPost(data)

            if (response.data.result) {
                return response.data.result;
            } else {
                throw new Error('Error getting block hash');
            }
        } catch (error) {
            // sanitizeRpcError scrubs error.config.auth (the node RPC password) in
            // place, so the rethrow cannot leak the credential through an upstream
            // console.error(..., err) sink (noteBlockFetchFailure, verifyReorg).
            logger.error(util.format('Error:', sanitizeRpcError(error)));
            throw error;
        }
    },

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

                const response = await this.rpcPost(data)

                if (response.data.result) {
                    return response.data.result;
                } else {
                    throw new Error('Error getting block hex');
                }
            } catch (error) {
                if (error.code === 'ECONNABORTED') {
                    tries = tries - 1
                    logger.info("Getting timeout trying to get block hex, trying again...")
                    // Back off 500ms between attempts so a persistently-flapping node is
                    // not hot-spun through all 10 tries near-instantly; matches the
                    // postWithRetry / getBlock retry cadence.
                    if (tries > 0) await this.sleep(500)
                } else {
                    logger.error(util.format('Error:', sanitizeRpcError(error)));
                    throw error;
                }
            }
        }

        throw new Error("There were problems getting a block hex. ")
    },

    // Recovery path for a block whose AuxPoW section skipAuxPow cannot traverse:
    // rebuild the pure (AuxPoW-free) block from RPC parts instead of stripping the
    // raw block hex. getblockheader
    // gives the 80-byte header, verbose getblock gives the in-block txid order,
    // and getrawtransaction gives each tx's canonical serialization, so the
    // result is byte-identical to what getBlockWithoutAuxPow would have
    // produced. Dogecoin 1.14 has no verbosity-2 getblock, so per-txid fetches
    // are the portable route. Deterministic across instances: the output
    // depends only on chain content.
    // Keep in sync with xchain-decoder/src/chain/blockchain_connector.js getBlockReassembled.
    async getBlockReassembled(blockhash) {
        try {
            // Older daemons append the AuxPoW bytes to getblockheader; the pure
            // header is always the first 80 bytes either way.
            const headerHex = (await this.getBlockHeader(blockhash, true)).substring(0, 160)
            const verboseBlock = await this.getBlockVerbose(blockhash)
            if (!verboseBlock || !Array.isArray(verboseBlock.tx)) {
                throw new Error('verbose getblock returned no tx array')
            }
            const txHexes = []
            for (const txid of verboseBlock.tx) {
                // getRawTransaction resolves null for a missing tx (mempool-eviction
                // tolerance); for a confirmed in-block tx that is an RPC fault, and
                // assembling without it would emit a corrupt block. Fail instead.
                const txHex = await this.getRawTransaction(txid)
                if (!txHex) throw new Error('no raw tx for in-block txid ' + txid)
                txHexes.push(txHex)
            }
            return headerHex + encodeVarintHex(txHexes.length) + txHexes.join('')
        } catch (err) {
            throw new Error("There were problems reassembling a block without auxpow. " + err.message)
        }
    },

    async getBlockVerbose(blockhash) {
        try {
            const data = {
                jsonrpc: '2.0',
                method: 'getblock',
                params: [blockhash, true],  // true = JSON with the in-block txid list (boolean verbose; Dogecoin 1.14 rejects integer verbosity)
                id: 1,
            }

            const response = await this.postWithRetry(data)

            if (response.data.result) {
                return response.data.result;
            } else {
                throw new Error('Error getting verbose block');
            }
        } catch (error) {
            logger.error(util.format('Error:', sanitizeRpcError(error)));
            throw error;
        }
    },

    // The two RPC fetches are deliberately OUTSIDE the try, matching the decoder twin
    // (xchain-decoder/src/chain/blockchain_connector.js getBlockWithoutAuxPow). A transport
    // fault (a Dogecoin 1.14 node dropping the connection when its RPC queue fills, a
    // restart, a network blip) must propagate unwrapped with error.code intact, because
    // the caller's escalation decision turns on cause: only a strip fault is evidence
    // that THIS BLOCK's bytes are the problem. Wrapping everything in a bare Error
    // erased that distinction and let ~15s of node unavailability flip the tracker into
    // per-tx block reassembly aimed at the node that was already saturated.
    async getBlockWithoutAuxPow(blockhash) {
        let blockHeaderHex = await this.getBlockHeader(blockhash, true)
        let blockHex = await this.getBlock(blockhash, true)

        try {
            // Dogecoin Core 1.14.x getblockheader always returns the pure 80-byte header
            // (160 hex chars) regardless of whether the block is merge-mined. When the
            // header is longer than 160 chars the legacy path (length-based strip) works;
            // when it is exactly 160 chars and the AuxPoW version bit (0x100) is set we
            // must parse the AuxPoW size from the block hex itself to find where the
            // AuxPoW section ends and the tx-count varint begins.
            return stripAuxPowFromBlockHex(blockHeaderHex, blockHex)
        } catch (err) {
            const parseErr = new Error("There were problems getting a block hex without auxpow. " + err.message)
            parseErr.auxPowParseFailure = true
            parseErr.cause = err
            throw parseErr
        }
    },

    async getBlock(blockhash, hexFormat=true) {
        try {
            const data = {
                jsonrpc: '2.0',
                method: 'getblock',
                params: [blockhash, !hexFormat],  // getblock verbose is a boolean (false=hex, true=json); Dogecoin 1.14 rejects integer verbosity, matching getBlockHeader above
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
            logger.error(util.format('Error:', error.message));
            throw error;
        }
    }
}
