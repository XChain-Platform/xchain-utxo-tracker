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
 * Run: mocha test/security/concurrency-gate.test.js --timeout 5000
 */

'use strict';

const { expect }  = require('chai');
const express     = require('express');
const http        = require('http');
const rateLimit   = require('express-rate-limit');
const { createConcurrencyGate, resolveLimit } = require('../../src/concurrencyGate.js');

// Servers opened by a test, torn down in afterEach.
let openServers = [];

const BUSY_BODY = { error: 'Server busy, retry shortly', code: 'SERVER_BUSY' };
const isProbe   = (req) => req.method === 'GET' && req.path === '/status';

/**
 * Stand up a miniature tracker with api.js's exact middleware order: the
 * production per-IP limiter, the probe reserve, the main gate, then handlers
 * that park until the test releases them. Parking is what makes "concurrent"
 * deterministic - requests stay in flight until we say so.
 */
function buildServer(options){
    options = options || {};

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
    app.get('/status', async (req, res) => {
        if(options.parkProbes) await heldProbe;
        res.json({ status: 'ok' });
    });

    const server = http.createServer(app);
    openServers.push(server);

    return {
        app, gate, probeGate, server,
        release:      () => releaseHeld(),
        releaseProbe: () => releaseProbe(),
        entered:      () => expensiveEntered,
        enteredHeld:  () => heldEntered
    };
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

describe('Security: global in-flight concurrency cap', function () {

    afterEach(function () {
        for(const server of openServers){
            // fetch keeps its sockets alive, so close() alone would hang.
            if(typeof server.closeAllConnections === 'function') server.closeAllConnections();
            server.close();
        }
        openServers = [];
    });

    it('refuses the (cap+1)th concurrent request with 429, though every request has a distinct IP', async function () {
        const CAP = 3;
        const { server, gate, release } = buildServer({ limit: CAP });
        await listen(server);

        // Saturate: CAP requests, CAP distinct source IPs, all parked in the handler.
        const parked = [];
        for(let i = 1; i <= CAP; i++) parked.push(get(server, '/expensive', i));
        await waitFor(() => gate.getStats().in_flight === CAP, 'gate to reach its cap');

        // The overflow request comes from yet another IP that has never been seen.
        const overflow = await get(server, '/expensive', CAP + 1);
        expect(overflow.status).to.equal(429);
        expect(overflow.headers.get('retry-after')).to.equal('1');

        const body = await overflow.json();
        // SERVER_BUSY (not RATE_LIMITED) proves the global cap shed it, not the per-IP limiter.
        expect(body.code).to.equal('SERVER_BUSY');
        expect(gate.getStats().shed).to.equal(1);

        // The parked requests were genuinely concurrent and genuinely distinct clients.
        release();
        const settled = await Promise.all(parked);
        const ips = [];
        for(const response of settled){
            expect(response.status).to.equal(200);
            ips.push((await response.json()).ip);
        }
        expect(new Set(ips).size).to.equal(CAP);
    });

    it('frees a slot when a request completes, so the next caller is served', async function () {
        const CAP = 1;
        const { server, gate, release } = buildServer({ limit: CAP });
        await listen(server);

        const parked = get(server, '/expensive', 1);
        await waitFor(() => gate.getStats().in_flight === 1, 'gate to reach its cap');

        expect((await get(server, '/expensive', 2)).status).to.equal(429);

        release();
        expect((await parked).status).to.equal(200);
        await waitFor(() => gate.getStats().in_flight === 0, 'slot to be released');

        expect((await get(server, '/expensive', 3)).status).to.equal(200);
        expect(gate.getStats().shed).to.equal(1);
    });

    it('frees a slot when the client aborts mid-request', async function () {
        // Without the 'close' leg an abandoned request keeps its slot forever
        // and the gate ratchets shut on a service that is doing nothing.
        const { server, gate } = buildServer({ limit: 1 });
        await listen(server);

        const controller = new AbortController();
        const aborted = get(server, '/expensive', 1, { signal: controller.signal });
        await waitFor(() => gate.getStats().in_flight === 1, 'gate to reach its cap');

        controller.abort();
        await aborted.catch(() => {});
        await waitFor(() => gate.getStats().in_flight === 0, 'aborted slot to be released');
    });

    it('keeps a held slot while the backend work runs on after the client aborts', async function () {
        // Express never awaits an async handler, so releasing on the socket's
        // 'close' let a client free its slot while its LevelDB scan was still
        // running: repeat the abort and the cap admits work it already counted
        // out. hold() binds the slot to the handler's promise instead.
        const { server, gate, release, enteredHeld } = buildServer({ limit: 1 });
        await listen(server);

        const controller = new AbortController();
        const aborted = get(server, '/held', 1, { signal: controller.signal });
        await waitFor(() => gate.getStats().in_flight === 1, 'gate to reach its cap');
        await waitFor(() => enteredHeld() === 1, 'the handler to have entered');

        controller.abort();
        await aborted.catch(() => {});
        // Deliberate delay, NOT a synchronization point: do not convert this to
        // waitFor. The claim is that in_flight STAYS 1 across a window in which
        // 'close' had every chance to fire and be ignored, so the elapsed time
        // IS the measurement. A predicate on in_flight === 1 already holds on
        // entry and would return on its first tick, asserting nothing; without
        // the wrapper the slot is already back by the end of this window.
        await new Promise(r => setTimeout(r, 50));

        expect(gate.getStats().in_flight).to.equal(1);
        // The behavioural half: the next caller is refused because the work the
        // first one started is still running.
        const overflow = await get(server, '/held', 2);
        expect(overflow.status).to.equal(429);
        expect((await overflow.json()).code).to.equal('SERVER_BUSY');
        expect(enteredHeld()).to.equal(1);

        release();
        await waitFor(() => gate.getStats().in_flight === 0, 'slot to come back once the work settled');
        expect((await get(server, '/held', 3)).status).to.equal(200);
    });

    it('negative control: with hold() stubbed out, the aborted slot is handed to the next caller', async function () {
        // The same scenario against a pass-through wrapper, which is exactly the
        // pre-fix gate. If this ever goes green the assertion above has stopped
        // measuring anything.
        const { server, gate, enteredHeld } = buildServer({ limit: 1, stubHold: true });
        await listen(server);

        const controller = new AbortController();
        const aborted = get(server, '/held', 1, { signal: controller.signal });
        await waitFor(() => gate.getStats().in_flight === 1, 'gate to reach its cap');
        await waitFor(() => enteredHeld() === 1, 'the handler to have entered');

        controller.abort();
        await aborted.catch(() => {});
        await waitFor(() => gate.getStats().in_flight === 0, 'the socket close to free the slot');

        // Over-admission: a second handler is now running the same expensive work
        // the cap of 1 was meant to forbid. It is never awaited, because it parks
        // in the handler exactly like the first one did.
        get(server, '/held', 2).catch(() => {});
        await waitFor(() => enteredHeld() === 2, 'a second handler to be admitted past the cap');
        expect(gate.getStats().shed).to.equal(0);
    });

    it('passes a request through hold() untouched when the gate holds no slot for it', async function () {
        // A disabled gate hands out no slots, so hold() must not invent one and
        // must not swallow the handler.
        const { server, gate, release, enteredHeld } = buildServer({ limit: 0 });
        await listen(server);

        const parked = get(server, '/held', 1);
        await waitFor(() => enteredHeld() === 1, 'the wrapped handler to run past the disabled gate');
        expect(gate.getStats()).to.deep.equal({ limit: 0, in_flight: 0, shed: 0 });

        release();
        expect((await parked).status).to.equal(200);
    });

    it('still answers the /status readiness probe while the main gate sheds', async function () {
        const { server, gate } = buildServer({ limit: 1 });
        await listen(server);

        get(server, '/expensive', 1);
        await waitFor(() => gate.getStats().in_flight === 1, 'gate to reach its cap');

        // A healthcheck that 429s while the service sheds gets the container restarted.
        expect((await get(server, '/status', 2)).status).to.equal(200);
        expect((await get(server, '/expensive', 3)).status).to.equal(429);
    });

    it('bounds the probe reserve too, so /status is not an uncapped bypass', async function () {
        // /status is exempt from the MAIN cap, not from every cap: it reads
        // LevelDB, so an unbounded exemption would just relocate the stampede.
        const { server, gate, probeGate, releaseProbe } = buildServer({
            limit: 10, probeLimit: 2, parkProbes: true
        });
        await listen(server);

        const parkedProbes = [get(server, '/status', 1), get(server, '/status', 2)];
        await waitFor(() => probeGate.getStats().in_flight === 2, 'probe reserve to fill');

        const overflow = await get(server, '/status', 3);
        expect(overflow.status).to.equal(429);
        expect((await overflow.json()).code).to.equal('SERVER_BUSY');
        expect(probeGate.getStats().shed).to.equal(1);

        // A saturated probe reserve must not consume the main capacity.
        expect(gate.getStats().in_flight).to.equal(0);

        releaseProbe();
        for(const response of await Promise.all(parkedProbes)) expect(response.status).to.equal(200);
    });

    it('is disabled by a cap of 0 (operator escape hatch)', async function () {
        const { server, gate, release, entered } = buildServer({ limit: 0 });
        await listen(server);

        const parked = [get(server, '/expensive', 1), get(server, '/expensive', 2), get(server, '/expensive', 3)];
        // Wait on the handler, not the clock. A disabled gate's stats read {0,0,0}
        // from the first millisecond, so a fixed sleep that ended early would satisfy
        // the assertion below without a single request having reached the route.
        await waitFor(() => entered() === 3, 'all three requests to reach the handler past the disabled gate');

        // A disabled gate counts nothing and sheds nothing; it must not become a
        // cap of zero that refuses every request.
        expect(gate.getStats()).to.deep.equal({ limit: 0, in_flight: 0, shed: 0 });

        release();
        for(const response of await Promise.all(parked)) expect(response.status).to.equal(200);
    });

    describe('resolveLimit', function () {

        it('keeps the caller default when the env var is unset or unparseable', function () {
            // A typo must not silently remove the cap.
            expect(resolveLimit(undefined, 100)).to.equal(100);
            expect(resolveLimit('', 100)).to.equal(100);
            expect(resolveLimit('lots', 100)).to.equal(100);
        });

        it('honours an explicit value and treats <= 0 as disabled', function () {
            expect(resolveLimit('25', 100)).to.equal(25);
            expect(resolveLimit('0', 100)).to.equal(0);
            expect(resolveLimit('-5', 100)).to.equal(0);
        });
    });

    describe('api.js wiring', function () {

        const fs        = require('fs');
        const path      = require('path');
        const apiSource = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');

        it('mounts the gate on the app with an env-overridable cap', function () {
            expect(apiSource).to.include('concurrencyGate.createConcurrencyGate');
            expect(apiSource).to.include('UTXO_TRACKER_MAX_CONCURRENT_REQUESTS');
            expect(apiSource).to.match(/app\.use\(requestGate\)/);
        });

        it('mounts a bounded reserve for the exempt readiness probe', function () {
            expect(apiSource).to.include('UTXO_TRACKER_MAX_CONCURRENT_PROBES');
            expect(apiSource).to.match(/app\.use\(probeGate\)/);
        });

        it('holds the slot across every route that awaits a backend read', function () {
            // A route added without the wrapper is back to counting sockets
            // instead of work, which is invisible at runtime: assert the wiring
            // in source so the regression is caught here instead of in traffic.
            for(const route of ['/utxos/:address', '/firstseen/:address', '/balance/:address', '/info/:address']){
                expect(apiSource).to.include(`app.get('${route}', requestGate.hold(`);
            }
            // /status is exempt from the main cap, so its slot lives in the probe
            // reserve and only that gate's hold() can claim it.
            expect(apiSource).to.include("app.get('/status', probeGate.hold(");
            // One wrap covers every JSON-RPC method, batches included.
            expect(apiSource).to.match(/app\.use\(requestGate\.hold\(jsonRouter\(/);
        });

        it('reports the gate stats so a stampede is visible to operators', function () {
            expect(apiSource).to.include('request_gate: requestGate.getStats()');
            expect(apiSource).to.include('probe_gate: probeGate.getStats()');
        });
    });
});
