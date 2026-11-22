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
 * Security: a JSON-RPC batch must not multiply the concurrency cap.
 *
 * The gate counts one slot per HTTP request, and the router starts every
 * entry of a batch at once. With a 20-entry batch cap and a 100-slot gate
 * that is up to 2000 concurrent heavy reads. These tests pin that the entries
 * of one request run one at a time, in order, on its single slot.
 */

'use strict';

const { expect } = require('chai');
const { EventEmitter } = require('events');
const { createConcurrencyGate } = require('../../../src/server/concurrency_gate');

function fakeRes() {
    const res = new EventEmitter();
    res.setHeader = () => {};
    res.status = () => res;
    res.json = () => res;
    return res;
}

function admit(gate) {
    const req = {};
    const res = fakeRes();
    let admitted = false;
    gate(req, res, () => { admitted = true; });
    expect(admitted, 'the gate should admit the request').to.equal(true);
    return { req, res };
}

const tick = () => new Promise((r) => setImmediate(r));

describe('Security: concurrency gate batch fan-out', function () {

    it('runs the entries of one request serially, in order, and frees the slot after the last', async function () {
        const gate = createConcurrencyGate({ limit: 1 });
        let live = 0;
        let peak = 0;
        const started = [];
        const releases = [];
        const tracked = gate.trackMethods({
            read(params) {
                started.push(params.i);
                live++;
                peak = Math.max(peak, live);
                return new Promise((resolve) => {
                    releases.push(() => { live--; resolve(params.i); });
                });
            }
        });

        const { req, res } = admit(gate);
        let results;
        const held = gate.hold(async (r) => {
            const calls = [];
            for (let i = 0; i < 20; i++) calls.push(tracked.read({ i }, { req: r, res }));
            results = Promise.all(calls);
        })(req, res, () => {});

        for (let n = 0; n < 20; n++) {
            await tick();
            expect(peak, 'entries running at once').to.equal(1);
            expect(started.length, 'entries started').to.equal(n + 1);
            expect(gate.getStats().in_flight).to.equal(1);
            releases[n]();
        }
        await held;
        expect(await results).to.deep.equal(Array.from({ length: 20 }, (_, i) => i));
        expect(peak).to.equal(1);
        expect(gate.getStats().in_flight).to.equal(0);
    });
});

describe('Security: concurrency gate batch fan-out failures', function () {

    it('a rejecting entry does not stall the later ones', async function () {
        const gate = createConcurrencyGate({ limit: 1 });
        const tracked = gate.trackMethods({
            ok(params) { return params.v; },
            bad() { throw new Error('entry failed'); },
            async badAsync() { throw new Error('async failed'); }
        });
        const { req, res } = admit(gate);
        let settled;
        await gate.hold(async (r) => {
            settled = await Promise.allSettled([
                tracked.ok({ v: 1 }, { req: r, res }),
                tracked.bad({}, { req: r, res }),
                tracked.badAsync({}, { req: r, res }),
                tracked.ok({ v: 4 }, { req: r, res })
            ]);
        })(req, res, () => {});

        expect(settled.map((s) => s.status)).to.deep.equal(['fulfilled', 'rejected', 'rejected', 'fulfilled']);
        expect(settled[3].value).to.equal(4);
        expect(settled[1].reason.message).to.equal('entry failed');
        expect(gate.getStats().in_flight).to.equal(0);
    });
});

describe('Security: concurrency gate batch fan-out scope', function () {

    it('separate requests still run in parallel; only one request is serialized', async function () {
        const gate = createConcurrencyGate({ limit: 5 });
        let live = 0;
        let peak = 0;
        const releases = [];
        const tracked = gate.trackMethods({
            read() {
                live++;
                peak = Math.max(peak, live);
                return new Promise((resolve) => { releases.push(() => { live--; resolve(); }); });
            }
        });
        const pending = [];
        for (let k = 0; k < 3; k++) {
            const { req, res } = admit(gate);
            pending.push(tracked.read({}, { req, res }));
        }
        await tick();
        expect(peak).to.equal(3);
        releases.forEach((r) => r());
        await Promise.all(pending);
    });

    it('a request with no slot is not serialized', async function () {
        const gate = createConcurrencyGate({ limit: 0 });
        let live = 0;
        let peak = 0;
        const releases = [];
        const tracked = gate.trackMethods({
            read() {
                live++;
                peak = Math.max(peak, live);
                return new Promise((resolve) => { releases.push(() => { live--; resolve(); }); });
            }
        });
        const req = {};
        const calls = [tracked.read({}, { req }), tracked.read({}, { req })];
        await tick();
        expect(peak).to.equal(2);
        releases.forEach((r) => r());
        await Promise.all(calls);
    });
});
