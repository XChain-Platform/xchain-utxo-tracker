/* Copyright © 2025-2026 Dankest, LLC; SPDX-License-Identifier: AGPL-3.0-or-later */
'use strict'

// A batch entry the router can treat as a request: a plain JSON object. The router
// reads entry.id outside any try, so a null entry would reject the whole middleware
// and orphan the entry's own promise (a 500 plus an unhandledRejection CRASH record);
// primitives and nested arrays are not requests either and would otherwise be
// dropped without an answer.
function isRequestObject(entry) {
    return entry !== null && typeof entry === 'object' && !Array.isArray(entry)
}

// API key enforcement for admin JSON-RPC methods. Fails closed: without a
// configured key these methods are rejected, never left open.
//
// Both a single request (body is an object) and a JSON-RPC batch (body is
// an array) reach the router registered after this guard, and the router executes every entry of
// a batch. So the guard must inspect EVERY method in the request, not just
// req.body.method: for an array body req.body.method is undefined, so without
// this guard an admin method smuggled inside a batch (e.g.
// [{"method":"restorebootstrap",...}]) skips the key check entirely and runs
// unauthenticated. Gate the whole request when ANY entry is an admin method.
function installAdminGuard(app, config) {
    app.use((req, res, next) => {
        const body = req.body
        // Bound batch fan-out BEFORE the router's uncapped Promise.all executes every
        // entry: an over-cap array is an amplification vector, not a legitimate request.
        if(Array.isArray(body) && body.length > config.MAX_JSONRPC_BATCH){
            return res.status(400).json({
                jsonrpc: '2.0', id: null,
                error: { code: -32600, message: 'Batch too large (max ' + config.MAX_JSONRPC_BATCH + ' requests per call)' }
            })
        }
        // A client fault, answered like the cap above before the router sees the batch.
        if(Array.isArray(body) && !body.every(isRequestObject)){
            return res.status(400).json({
                jsonrpc: '2.0', id: null,
                error: { code: -32600, message: 'Invalid Request: every batch entry must be a JSON object' }
            })
        }
        const entries = Array.isArray(body) ? body : [body]
        const wantsAdmin = entries.some(e =>
            e && typeof e.method === 'string' && config.ADMIN_METHODS.has(e.method.toLowerCase()))
        if(wantsAdmin){
            const header = req.headers['authorization']
            if(!config.UTXO_TRACKER_API_KEY || !header
                || !config.keyEquals(header, 'Bearer ' + config.UTXO_TRACKER_API_KEY)){
                return res.status(401).json({
                    jsonrpc: '2.0', id: (!Array.isArray(body) && body && body.id) || null,
                    error: { code: -32001, message: 'Unauthorized' }
                })
            }
        }
        next()
    })
}

module.exports = { installAdminGuard, isRequestObject }
