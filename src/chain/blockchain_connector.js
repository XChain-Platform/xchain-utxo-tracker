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
const config = require('../config');
const { encodeVarintHex } = require('./blockchain_connector/auxpow_codec');
const { nodeReachabilityFrom } = require('./blockchain_connector/rpc_helpers');
const transportAndMempool = require('./blockchain_connector/transport_and_mempool');
const blockQueries = require('./blockchain_connector/block_queries');
const batchFetch = require('./blockchain_connector/batch_fetch');

class BlockchainConnector {
    constructor(url, port, rpcUser, rpcPassword) {
        this.url = "http://"+url+":"+port
        this.port = port
        this.rpcUser = rpcUser
        this.rpcPassword = rpcPassword

        // Reuse TCP connections across all RPC calls and authenticate once per instance
        this.client = axios.create({
            timeout: config.NODE_RPC_TIMEOUT_MS,
            httpAgent: new http.Agent({ keepAlive: true, maxSockets: 25 }),
            auth: { username: rpcUser, password: rpcPassword }
        })

        // Node reachability, recorded at the single POST choke point below so every
        // RPC path through this class feeds it, batches included. Reported, never gated
        // on: the healthy verdict deliberately ignores an upstream node outage (a
        // restart cannot fix one, and gating re-opens the autoheal restart flap), which
        // is exactly why the outage needs a surface of its own.
        //
        // Distinct from XChainUtxoTracker.lastNodeRpcOkAt, which the /status probe reads:
        // that one is stamped only by the sync loop's own tip read, so it says nothing
        // about a tracker whose loop has not yet completed a single poll.
        this.startedAt = Date.now()
        this.lastNodeOkAt = 0
        this.lastNodeFailAt = 0
    }
}

Object.assign(
    BlockchainConnector.prototype,
    transportAndMempool,
    blockQueries,
    batchFetch
)

module.exports = BlockchainConnector

// Attached to the class rather than exported one line at a time: one export
// shape per file, and every call site already reaches these through the module
// object, so nothing outside changes.
Object.assign(module.exports, {
    // Exported for the malformed-AuxPoW reassembly regression test.
    encodeVarintHex,
    // Exported so the reachability reducer can be tested without a connector or a node.
    nodeReachabilityFrom,
})
