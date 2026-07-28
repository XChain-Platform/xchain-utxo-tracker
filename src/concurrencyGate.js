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
 * XChain UTXO Tracker - global in-flight concurrency gate 
 *
 * The per-IP rate limiter in front of this bounds how fast ONE client may
 * ask; it says nothing about how many distinct clients arrive at once. A
 * distinct-IP stampede (scrapers rotating exit nodes, a botnet, a launch-day
 * link) stays under every per-IP bucket while saturating the LevelDB read
 * path and every event-loop slot, so the service degrades into timeouts for
 * everybody instead of refusing the excess. This gate counts requests actually in
 * flight process-wide and answers the (cap+1)th with an immediate 429 +
 * Retry-After no matter which IP it came from.
 *
 * Shed, do not queue. A queued request still holds the caller's socket, hides
 * the overload from its retry logic, and by the time it runs the client has
 * usually given up and re-asked - which is how a stampede compounds. Same
 * reasoning as the xchain-sync snapshot semaphore , which answers a
 * saturated snapshot cap itself rather than waiting for a slot.
 *
 ********************************************************************/

'use strict';

// Parse a cap from the environment. A missing or unparseable value keeps the
// caller's default (fail-safe: a typo must not silently remove the cap), and
// anything <= 0 disables the gate outright as the operator escape hatch.
function resolveLimit(rawValue, defaultLimit){
    let parsed = parseInt(rawValue, 10);
    let limit  = Number.isFinite(parsed) ? parsed : defaultLimit;
    return limit > 0 ? limit : 0;
}

/**
 * Build the gate middleware.
 *
 * @param {object}   options
 * @param {number}   options.limit       Max concurrent in-flight requests; <= 0 disables.
 * @param {number}   [options.retryAfter=1] Retry-After header value, seconds.
 * @param {function} [options.skip]      (req) => true to exempt a request from the cap.
 * @param {object|function} [options.body] 429 JSON body, or (req) => body.
 * @returns {function} Express middleware, with .getStats() and .limit attached.
 */
function createConcurrencyGate(options){
    options = options || {};

    const limit      = options.limit > 0 ? Math.floor(options.limit) : 0;
    const retryAfter = Number.isFinite(options.retryAfter) ? options.retryAfter : 1;
    const skip       = typeof options.skip === 'function' ? options.skip : () => false;
    const body       = options.body || { error: 'Server busy, retry shortly', code: 'SERVER_BUSY' };

    let inFlight = 0;
    let shed     = 0;

    const middleware = function concurrencyGate(req, res, next){
        if(limit <= 0 || skip(req)) return next();

        if(inFlight >= limit){
            shed++;
            res.setHeader('Retry-After', String(retryAfter));
            res.status(429).json(typeof body === 'function' ? body(req) : body);
            return;
        }

        inFlight++;
        let released = false;
        const release = () => {
            if(released) return;
            released = true;
            inFlight--;
        };
        // 'finish' fires on a fully-sent response; 'close' on a client abort or
        // a handler that never answers. Whichever lands first frees the slot,
        // and the guard makes the pair idempotent (both fire on a normal
        // response). Without the 'close' leg an aborted request would leak its
        // slot permanently and the gate would ratchet shut on a live service.
        res.on('finish', release);
        res.on('close', release);

        next();
    };

    middleware.limit    = limit;
    // Operational surface: a climbing `shed` is the signal that a stampede is
    // being refused, the same way sync exposes snapshots_rejected .
    middleware.getStats = () => ({ limit, in_flight: inFlight, shed });

    return middleware;
}

module.exports = { createConcurrencyGate, resolveLimit };
