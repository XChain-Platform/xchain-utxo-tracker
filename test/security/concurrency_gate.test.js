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

const { expect }  = require('chai');
const {
    buildServer, closeServers, get, listen, waitFor
} = require('./concurrency_gate.test/support');

// Express answers the bare `app.get('/status')` route for HEAD, for a
// trailing slash and for any letter case. An unguarded probe predicate
// fails each of those, so the MAIN gate admits them while probeGate.hold()
// finds no slot of its own and degrades to a pass-through: the request's
// main-cap slot is then freed by the socket close while the handler's
// LevelDB read is still running. Each variant is asserted twice: it lands
// in the probe reserve rather than the main cap, and an abort does not free
// its slot while the handler is still parked.
const PROBE_VARIANTS = [
    { label: 'HEAD /status',  path: '/status',  init: { method: 'HEAD' } },
    { label: 'GET /status/',  path: '/status/', init: undefined },
    { label: 'GET /STATUS',   path: '/STATUS',  init: undefined }
];

describe('Security: global in-flight concurrency cap', function () {

    afterEach(closeServers);

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
});

describe('Security: global in-flight concurrency cap', function () {

    afterEach(closeServers);

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
});

describe('Security: global in-flight concurrency cap', function () {

    afterEach(closeServers);

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

        // Over-admission: a second handler is running the same expensive work
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
});

describe('Security: global in-flight concurrency cap', function () {

    afterEach(closeServers);

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
});

describe('Security: global in-flight concurrency cap', function () {

    afterEach(closeServers);

    for(const variant of PROBE_VARIANTS){
        it(`routes ${variant.label} to the probe reserve, not the main cap`, async function () {
            const { server, gate, probeGate, releaseProbe } = buildServer({
                limit: 10, probeLimit: 2, parkProbes: true
            });
            await listen(server);

            const parked = get(server, variant.path, 1, variant.init);
            await waitFor(() => probeGate.getStats().in_flight === 1,
                `${variant.label} to occupy a probe slot`);
            // The load-bearing half: before the fix this read 1, because the
            // main gate was the admitting gate for this request.
            expect(gate.getStats().in_flight).to.equal(0);

            releaseProbe();
            expect((await parked).status).to.equal(200);
        });

        it(`keeps ${variant.label}'s slot held across a client abort`, async function () {
            const { server, gate, probeGate, releaseProbe } = buildServer({
                limit: 10, probeLimit: 2, parkProbes: true
            });
            await listen(server);

            const controller = new AbortController();
            const init = Object.assign({ signal: controller.signal }, variant.init || {});
            // fetch rejects on abort; that rejection is expected, not a failure.
            const aborted = get(server, variant.path, 1, init).catch(() => 'aborted');
            await waitFor(() => probeGate.getStats().in_flight === 1,
                `${variant.label} to occupy a probe slot`);

            controller.abort();
            expect(await aborted).to.equal('aborted');

            // The claim is that in_flight STAYS 1 while the handler is parked.
            // Poll across a window so a delayed socket-close release would still
            // be caught; a pass-through hold() dropped this to 0 on abort.
            for(let i = 0; i < 20; i++){
                expect(probeGate.getStats().in_flight).to.equal(1);
                await new Promise(r => setTimeout(r, 5));
            }
            expect(gate.getStats().in_flight).to.equal(0);

            releaseProbe();
            await waitFor(() => probeGate.getStats().in_flight === 0,
                'the probe slot to come back once the parked work settled');
        });
    }
});

describe('Security: global in-flight concurrency cap', function () {

    afterEach(closeServers);

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
});
