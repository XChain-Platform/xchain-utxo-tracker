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
const { nodeReachabilityFrom, sanitizeRpcError } = require('./rpc_helpers');

module.exports = {
    async sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    },

    // Node reachability as the health surfaces publish it. Cheap and never throws,
    // so a probe can call it per request.
    nodeReachability(now = Date.now()) {
        return nodeReachabilityFrom(this.startedAt, this.lastNodeOkAt, this.lastNodeFailAt, now)
    },

    // Single POST path for every RPC method in this class. It exists so reachability
    // has one choke point instead of six near-identical `this.client.post` call sites;
    // it adds no retry or classification of its own, leaving each method's ladder
    // exactly as it was.
    async rpcPost(data) {
        try {
            const response = await this.client.post(this.url, data)
            // The node answered. A JSON-RPC error carried in a 200 body (height out of
            // range, tx not found) still resolves here and still counts as reached:
            // this pair reports whether the node is ANSWERING, not whether the answer
            // was the one the caller wanted.
            this.lastNodeOkAt = Date.now()
            return response
        } catch (error) {
            // Timeouts (ECONNABORTED), socket/DNS faults and RPC errors delivered as
            // HTTP 500 all land here, and all mean this attempt got no usable answer.
            this.lastNodeFailAt = Date.now()
            throw error
        }
    },

    async getRawMempool(){
        try {
            const data = {
                jsonrpc: '2.0',
                method: 'getrawmempool',
                id: 1
            }

            const response = await this.rpcPost(data)

            if (response.data.result) {
                return response.data.result;
            } else {
                throw new Error('Error getting raw mempool info');
            }
        } catch (error){
            // Scrub the node RPC password from error.config.auth in place before
            // the rethrow reaches updateMempool's console.error(..., error) sink.
            logger.error(util.format('Error:', sanitizeRpcError(error)));
            throw error;
        }
    },

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

                    const response = await this.rpcPost(data)

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
    },

    async getRawTransactions(txIdArray){
        let requests = []

        for (let nextTxIdIndex in txIdArray){
            let nextTxId = txIdArray[nextTxIdIndex]

            requests.push(this.getRawTransaction(nextTxId))
        }

        return Promise.all(requests)
    },

    // POST a (batched) JSON-RPC payload, retrying on transient connection timeouts.
    // Mirrors the ECONNABORTED retry loop in getBlockHeader: up to 10 attempts with a
    // short backoff. The batch methods route every .post() through here so a single
    // transient timeout doesn't throw away the whole batch window; without this, one
    // flaky request evicts all prefetched heights and forces slow single-block refetching.
    async postWithRetry(data) {
        let tries = 10

        while (tries > 0) {
            try {
                return await this.rpcPost(data)
            } catch (error) {
                if (error.code === 'ECONNABORTED') {
                    tries = tries - 1
                    logger.info("Getting timeout on a batch RPC call, trying again...")
                    await this.sleep(500)
                } else {
                    logger.error(util.format('Error:', sanitizeRpcError(error)))
                    throw error
                }
            }
        }

        throw new Error("There were problems with a batch RPC call after retries. ")
    }
}
