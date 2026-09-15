/*
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
 * Security: global in-flight concurrency cap.
 *
 * The tracker's per-IP rate limiter cannot see a stampede spread across many
 * source IPs: every bucket stays under its own limit while the process burns
 * all of its LevelDB read throughput on address scans. These tests drive the
 * real gate over real HTTP with a DISTINCT forged client IP per request, so a
 * shed can only come from the global cap - the per-IP limiter is mounted
 * alongside at its production default and never fires.
 *
 * Run: mocha test/security/concurrency_gate.test.js --timeout 5000
 */

'use strict';

const express     = require('express');
const http        = require('http');
const rateLimit   = require('express-rate-limit');
const { createConcurrencyGate } = require('../../../src/server/concurrency_gate.js');

// Servers opened by a test, torn down in afterEach.
let openServers = [];

const BUSY_BODY = { error: 'Server busy, retry shortly', code: 'SERVER_BUSY' };
// Mirrors api.js exactly: the predicate must cover every request Express
// routes to `app.get('/status')` under the default routing options - HEAD,
// a trailing slash, any letter case - or the gate that admits the request is
// not the gate whose hold() spans the handler.
const PROBE_PATH = /^\/status\/?$/i;
const isProbe   = (req) => (req.method === 'GET' || req.method === 'HEAD') && PROBE_PATH.test(req.path);

function createApp(options){
    const app = express();
    // Same trust-proxy setting api.js uses, so an X-Forwarded-For hop becomes req.ip.
    app.set('trust proxy', 1);

    // The per-IP limiter at its production default. With one request per forged
    // IP, every bucket sees a single hit, so this can never be the thing that
    // sheds below; a 429 carrying RATE_LIMITED instead of SERVER_BUSY would
    // mean the test proved nothing.
    app.use(rateLimit({
        windowMs:        60 * 1000,
        limit:           500,
        standardHeaders: true,
        legacyHeaders:   false,
        message:         { error: 'Too many requests', code: 'RATE_LIMITED' }
    }));

    const probeGate = createConcurrencyGate({
        limit:      options.probeLimit !== undefined ? options.probeLimit : 16,
        retryAfter: 1,
        skip:       (req) => !isProbe(req),
        body:       BUSY_BODY
    });
    app.use(probeGate);

    const gate = createConcurrencyGate({
        limit:      options.limit,
        retryAfter: 1,
        skip:       isProbe,
        body:       BUSY_BODY
    });
    app.use(gate);

    return { app, gate, probeGate };
}

function createRoutes(app, gate, probeGate, options){
    let releaseHeld, releaseProbe;
    const held      = new Promise(resolve => { releaseHeld  = resolve; });
    const heldProbe = new Promise(resolve => { releaseProbe = resolve; });

    // Counts handler entries. A DISABLED gate reports {0,0,0} at all times, so its
    // stats carry no signal a test can synchronize on; this is the positive proof
    // that a request got past the gate instead of never having been dispatched.
    let expensiveEntered = 0;
    let heldEntered      = 0;

    app.get('/expensive', async (req, res) => {
        expensiveEntered++;
        await held;
        res.json({ ok: true, ip: req.ip });
    });
    // The same parked handler, wrapped the way api.js wraps its address routes.
    // `hold` is stubbed to a pass-through when a test asks for it, which is what
    // the gate did before it had one: that is the negative control for the
    // held-slot assertions below, not a second flavour of the same route.
    const wrap = options.stubHold ? (fn) => fn : gate.hold;
    app.get('/held', wrap(async (req, res) => {
        heldEntered++;
        await held;
        res.json({ ok: true, ip: req.ip });
    }));
    // The real /status reads the committed height out of LevelDB, so it can be
    // made to park exactly like an expensive route; opts in per test.
    // Wrapped in probeGate.hold the way api.js wraps it. Unwrapped, the harness
    // could not see the defect at all: hold() is what turns a socket-lifetime
    // slot into a work-lifetime one, and the whole misclassification class is
    // about hold() looking for a slot the OTHER gate admitted.
    app.get('/status', probeGate.hold(async (req, res) => {
        if(options.parkProbes) await heldProbe;
        res.json({ status: 'ok' });
    }));

    return {
        release:      () => releaseHeld(),
        releaseProbe: () => releaseProbe(),
        entered:      () => expensiveEntered,
        enteredHeld:  () => heldEntered
    };
}

/**
 * Stand up a miniature tracker with api.js's exact middleware order: the
 * production per-IP limiter, the probe reserve, the main gate, then handlers
 * that park until the test releases them. Parking is what makes "concurrent"
 * deterministic - requests stay in flight until we say so.
 */
function buildServer(options){
    options = options || {};
    const { app, gate, probeGate } = createApp(options);
    const routes = createRoutes(app, gate, probeGate, options);
    const server = http.createServer(app);
    openServers.push(server);
    return { app, gate, probeGate, server, ...routes };
}

function closeServers(){
    for(const server of openServers){
        // fetch keeps its sockets alive, so close() alone would hang.
        if(typeof server.closeAllConnections === 'function') server.closeAllConnections();
        server.close();
    }
    openServers = [];
}

function listen(server){
    return new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
}

function urlFor(server, path){
    return 'http://127.0.0.1:' + server.address().port + path;
}

// Requests from N different "clients". One IP per request is the whole point:
// it is the traffic shape a per-IP limiter is blind to.
function get(server, path, ipSuffix, init){
    return fetch(urlFor(server, path), Object.assign({
        headers: { 'X-Forwarded-For': '203.0.113.' + ipSuffix }
    }, init || {}));
}

/**
 * Poll until predicate() holds, or REJECT naming what was being waited for.
 * The rejection is the whole point: a waiter that cannot time out converts a
 * flake into a test that passes unconditionally, which is strictly worse than
 * the flake. timeoutMs is a bound, not a knob - a site that needs a longer one
 * is a finding about that site, not something to widen here.
 */
async function waitFor(predicate, label, timeoutMs = 2000){
    const deadline = Date.now() + timeoutMs;
    while(Date.now() < deadline){
        if(predicate()) return;
        // The helper's own poll interval, not a synchronization sleep.
        await new Promise(r => setTimeout(r, 5));
    }
    throw new Error('timed out after ' + timeoutMs + 'ms waiting for: ' + label);
}

module.exports = { buildServer, closeServers, get, listen, waitFor };
