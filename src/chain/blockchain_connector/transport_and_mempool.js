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
const { envInt } = require('../../config/env_int');

const CONNECTION_ERROR_CODES = new Set([
    'ECONNREFUSED', 'ECONNRESET', 'ECONNABORTED', 'ENOTFOUND',
    'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE'
])

// getRawTransaction's fault handling. Keep in sync with getRawTransaction in
// xchain-decoder/src/chain/blockchain_connector/transaction_queries.js (both feed getBlockReassembled).

// Return a truthy result only if it is a whole hex string; throw into the retry loop otherwise.
// (Callers decode outside their tagged try, so a non-hex answer would quarantine as content.)
function wholeHexResult(result, txid) {
    if (typeof result === 'string' && result.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(result)) return result
    const shape = typeof result === 'string' ? `a ${result.length}-char string` : `a ${typeof result}`
    throw new Error(`getRawTransaction: malformed result for txid ${txid}: expected whole hex, got ${shape}`)
}

// Resolve a 200 answer, rethrowing a coded non -5 body error so both transports classify alike.
function rawTransactionResponse(response, txid) {
    const bodyError = response.data?.error
    if (bodyError && typeof bodyError.code === 'number' && bodyError.code !== -5) {
        // Build a fresh error per attempt: sanitizeRpcError scrubs error.response in place.
        const err = new Error(`getRawTransaction: RPC error ${bodyError.code}: ${bodyError.message}`)
        err.response = { status: response.status, data: { error: { code: bodyError.code, message: bodyError.message } } }
        throw err
    }
    if (response.data.result) return wholeHexResult(response.data.result, txid)

    // Resolve null for a tx the node no longer has (mined or evicted); callers filter nulls.
    if (bodyError?.code === -5) {
        logger.warn(`getRawTransaction: node error for txid ${txid}: code ${bodyError.code} ${bodyError.message}`)
    } else if (bodyError) {
        logger.error(`getRawTransaction: node error for txid ${txid}: code ${bodyError.code} ${bodyError.message}`)
    } else {
        logger.info(`getRawTransaction: no result for txid ${txid} (evicted/confirmed?)`)
    }
    return null
}

// Classify a thrown fault. Read the code and status before sanitizeRpcError scrubs error.response.
function rawTransactionFailureDetails(error) {
    const httpStatus = error.response?.status
    const rpcCode = error.response?.data?.error?.code
    // Core signals a full work queue as -429; Dogecoin 1.14 drops the socket instead.
    const isQueueFull = rpcCode === -429 || error.code === 'ECONNRESET' || error.code === 'ECONNREFUSED'
    const isTimeout = error.code === 'ECONNABORTED'
    return { httpStatus, rpcCode, isQueueFull, isTimeout, lastErrorSummary: sanitizeRpcError(error) }
}

// Handle one failed attempt: resolve null on RPC -5, else log a deterministic fault and back off.
async function handleRawTransactionFailure(connector, error, txid, tries, maxTries) {
    if (error.response?.data?.error?.code === -5) {
        logger.info(`getRawTransaction: tx not found (RPC -5) for txid ${txid} (evicted/confirmed?)`)
        return { resolved: true, value: null }
    }
    if (error.code === 'ECONNABORTED') {
        logger.info("Getting timeout trying to get raw transaction, trying again...")
    }
    const details = rawTransactionFailureDetails(error)
    if (!details.isTimeout && !details.isQueueFull) {
        const status = details.httpStatus !== undefined ? details.httpStatus : 'n/a'
        const code = details.rpcCode !== undefined ? details.rpcCode : 'n/a'
        logger.error(`getRawTransaction: attempt ${tries}/${maxTries} for txid ${txid} failed: HTTP ${status} rpcCode ${code}: ${details.lastErrorSummary}`)
    }
    await connector.sleep(details.isQueueFull ? 5000 : 500)
    return { resolved: false, lastErrorSummary: details.lastErrorSummary }
}

// Run up to 10 attempts; the tracker keeps no rpcErrors counter, so none is bumped here.
async function runRawTransactionRetries(connector, txid, resolve, reject) {
    const maxTries = 10
    let lastErrorSummary = null
    for (let tries = 1; tries <= maxTries; tries++){
        try {
            const data = { jsonrpc: '2.0', method: 'getrawtransaction', params: [txid], id: 1 }
            const response = await connector.rpcPost(data)
            resolve(rawTransactionResponse(response, txid))
            return
        } catch (error){
            const outcome = await handleRawTransactionFailure(connector, error, txid, tries, maxTries)
            if (outcome.resolved) {
                resolve(outcome.value)
                return
            }
            lastErrorSummary = outcome.lastErrorSummary
        }
    }
    reject(new Error(`getRawTransaction failed after ${maxTries} attempts for txid ${txid}${lastErrorSummary ? ': ' + lastErrorSummary : ''}`))
}

module.exports = {
    async sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    },

    // Node reachability as the health surfaces publish it. Cheap and never throws,
    // so a probe can call it per request.
    nodeReachability(now = Date.now()) {
        return nodeReachabilityFrom(this.startedAt, this.lastNodeOkAt, this.lastNodeFailAt, now)
    },

    // Single POST path for every RPC method. It records reachability, resets the
    // failure streak on a response, and rotates endpoints on transport failures.
    // Retry policy remains with each caller.
    async rpcPost(data) {
        try {
            const response = await this.client.post(this.url, data)
            this.connectionFailures = 0
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
            if (error && error.response) {
                this.connectionFailures = 0
            } else if (error && CONNECTION_ERROR_CODES.has(error.code)) {
                this.noteConnectionFailure(error.code)
            }
            throw error
        }
    },

    noteConnectionFailure(code) {
        if (this.endpoints.length < 2) return
        if (++this.connectionFailures >= this.failoverThreshold) {
            const failing = this.url
            this.activeEndpointIndex = (this.activeEndpointIndex + 1) % this.endpoints.length
            this.connectionFailures = 0
            logger.warn(`RPC endpoint ${failing} unreachable (${code} x${this.failoverThreshold}); failing over to ${this.url}`)
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
        return new Promise((resolve, reject) => runRawTransactionRetries(this, txid, resolve, reject))
    },

    // Fetch raw transactions with bounded concurrency, in order-preserving waves.
    // Firing a whole list at once holds one socket per txid against the operator's
    // node (a 1000-tx mempool chunk, or every tx of a large block on the reassembly
    // path), and each dropped request then retries up to 10x. The bound is read per
    // call so a test or an operator can retune it; tune via UTXO_TRACKER_RPC_CONCURRENCY.
    async getRawTransactions(txIdArray){
        const concurrency = envInt('UTXO_TRACKER_RPC_CONCURRENCY', 50, 1)
        const results = []
        for (let i = 0; i < txIdArray.length; i += concurrency){
            const wave = txIdArray.slice(i, i + concurrency)
            results.push(...await Promise.all(wave.map((txid) => this.getRawTransaction(txid))))
        }
        return results
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
