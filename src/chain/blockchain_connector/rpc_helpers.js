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

// Sanitize an axios error before it is logged or re-thrown. RPC calls pass
// auth:{username,password} to axios, which attaches the request config to the
// thrown error, so logging the raw error serializes the node RPC password into
// the tracker logs (util.inspect walks error.config.auth). Scrub the credential
// fields in place so neither this logger nor any upstream handler leaks them, and
// return a compact, credential-free string (error.message never carries auth).
// Kept in sync with xchain-decoder/src/chain/blockchain_connector.js sanitizeRpcError.
function sanitizeRpcError(error){
    try {
        if (error && error.config) {
            error.config.auth = undefined
            if (error.config.headers) delete error.config.headers.Authorization
        }
        if (error && error.request) error.request = undefined
        if (error && error.response) {
            const status = error.response.status
            error.response = (status !== undefined) ? { status: status } : undefined
        }
    } catch (_) { /* sanitization must never mask the original failure */ }
    return (error && error.message) ? error.message : String(error)
}

// Reorder a JSON-RPC batch response into an array indexed by request id (0..N-1).
// The batch handlers below build requests with id:i, so sorting the response by id
// and then reading the result POSITIONALLY corrects reordering and nothing else: a
// response with a duplicated, missing, or out-of-range id silently maps block hex
// to the WRONG height (positional index i no longer equals request id i). The live
// sync loop self-heals via its prevHash link check, but the bulk-sync dump consumer
// does not, so one Byzantine/buggy node response corrupts a distributed bootstrap
// dump. Validate cardinality and id bijection here so any deviation is a clean,
// diagnosable throw instead of a silent mis-assignment (or a bare TypeError on an
// undefined element).
function orderBatchResults(responseData, expectedCount, label){
    if (!Array.isArray(responseData)){
        throw new Error('Batch RPC ' + label + ': expected an array response, got ' + typeof responseData)
    }
    if (responseData.length !== expectedCount){
        throw new Error('Batch RPC ' + label + ': expected ' + expectedCount + ' results, got ' + responseData.length)
    }
    const byId = new Array(expectedCount)
    for (const item of responseData){
        const id = item ? item.id : undefined
        if (!Number.isInteger(id) || id < 0 || id >= expectedCount){
            throw new Error('Batch RPC ' + label + ': response id ' + JSON.stringify(id) + ' out of range [0,' + expectedCount + ')')
        }
        if (byId[id] !== undefined){
            throw new Error('Batch RPC ' + label + ': duplicate response id ' + id)
        }
        byId[id] = item
    }
    // Every slot is filled: length === expectedCount and all ids are unique in range.
    return byId
}

// Reduce the three timestamps the connector records into the two fields every health
// surface publishes. Pure and exported so the rule lives in one place: a surface that
// re-derived "is the node reachable" from a counter would disagree with this one.
// Byte-for-byte the same rule as xchain-decoder/src/chain/blockchain_connector.js.
//
// Unreachable means the LATEST attempt failed: either nothing has ever succeeded, or
// the last failure is newer than the last success. `since` dates the outage from the
// last success when there was one, and from connector construction when there was
// never one, which is the case the defect report describes: a service whose node
// answered nothing in five and a half days while every surface read green.
//
// All three inputs are ms epoch, 0 meaning "never".
function nodeReachabilityFrom(startedAt, lastNodeOkAt, lastNodeFailAt, now = Date.now()) {
    const lastOkIso = lastNodeOkAt > 0 ? new Date(lastNodeOkAt).toISOString() : null
    const failing = lastNodeFailAt > 0 && (lastNodeOkAt === 0 || lastNodeFailAt > lastNodeOkAt)
    if (!failing) return { node_last_ok_at: lastOkIso, node_unreachable: null }
    const sinceMs = lastNodeOkAt > 0 ? lastNodeOkAt : startedAt
    return {
        node_last_ok_at: lastOkIso,
        node_unreachable: {
            since: new Date(sinceMs).toISOString(),
            last_ok_at: lastOkIso,
            // Floor, and clamped at 0: a health probe racing the recorded instant
            // must never publish a negative age.
            seconds: Math.max(0, Math.floor((now - sinceMs) / 1000))
        }
    }
}

module.exports = { sanitizeRpcError, orderBatchResults, nodeReachabilityFrom }
