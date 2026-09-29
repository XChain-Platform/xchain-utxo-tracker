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
 * Security: work a held handler starts but does not await still holds the slot.
 *
 * The JSON-RPC router settles before its id-less batch entries finish, so
 * their reads are registered through track(). These pin track() itself: the
 * slot outlives the handler until tracked work settles, and a request the gate
 * never admitted passes through untouched.
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

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

// Admit one request through the gate and return its req/res pair.
function admit(gate) {
    const req = {};
    const res = fakeRes();
    let admitted = false;
    gate(req, res, () => { admitted = true; });
    expect(admitted, 'the gate should admit the request').to.equal(true);
    return { req, res };
}

describe('Security: concurrency gate track()', function () {

    it('keeps in_flight at 1 until tracked work settles after the handler returns', async function () {
        const gate = createConcurrencyGate({ limit: 1 });
        const { req, res } = admit(gate);
        const work = deferred();

        let tracked;
        const held = gate.hold(async (r) => {
            tracked = gate.track(r, work.promise);
            return 'handler done';
        })(req, res, () => {});

        // The handler has returned, but its tracked work is still pending.
        await new Promise((r) => setImmediate(r));
        expect(tracked).to.equal(work.promise);
        expect(gate.getStats().in_flight).to.equal(1);
        // The finish leg must not free a claimed slot early either.
        res.emit('finish');
        expect(gate.getStats().in_flight).to.equal(1);

        work.resolve();
        expect(await held).to.equal('handler done');
        expect(gate.getStats().in_flight).to.equal(0);
    });

    it('releases the slot once when tracked work rejects, without surfacing the rejection', async function () {
        const gate = createConcurrencyGate({ limit: 1 });
        const { req, res } = admit(gate);
        const work = deferred();
        // The caller that owns the promise handles its rejection, as the router does.
        work.promise.catch(() => {});

        const held = gate.hold(async (r) => { gate.track(r, work.promise); })(req, res, () => {});
        work.reject(new Error('scan failed'));
        await held;

        expect(gate.getStats().in_flight).to.equal(0);
        res.emit('close');
        expect(gate.getStats().in_flight).to.equal(0);
    });

    it('passes the promise through when the gate is disabled or never admitted the request', function () {
        const disabled = createConcurrencyGate({ limit: 0 });
        const p = Promise.resolve(1);
        expect(disabled.track({}, p)).to.equal(p);
        expect(disabled.track(undefined, p)).to.equal(p);

        // A slot under another gate's key is not this gate's to extend.
        const other = createConcurrencyGate({ limit: 1 });
        const { req } = admit(other);
        const gate = createConcurrencyGate({ limit: 1 });
        expect(gate.track(req, p)).to.equal(p);
        expect(gate.getStats().in_flight).to.equal(0);
    });
});

describe('Security: concurrency gate trackMethods()', function () {

    it('trackMethods keeps keys and `this`, tracks each call, and turns a sync throw into a rejection', async function () {
        const gate = createConcurrencyGate({ limit: 1 });
        const table = {
            label: 'table',
            whoAmI() { return this.label; },
            boom() { throw new Error('sync throw'); }
        };
        const tracked = gate.trackMethods(table);
        expect(Object.keys(tracked)).to.deep.equal(['label', 'whoAmI', 'boom']);
        expect(tracked.label).to.equal('table');

        const { req, res } = admit(gate);
        let result;
        let failure;
        await gate.hold(async (r) => {
            result = await tracked.whoAmI({}, { req: r, res });
            failure = await tracked.boom({}, { req: r, res }).catch((e) => e);
        })(req, res, () => {});

        expect(result).to.equal('table');
        expect(failure.message).to.equal('sync throw');
        expect(gate.getStats().in_flight).to.equal(0);
    });
});
