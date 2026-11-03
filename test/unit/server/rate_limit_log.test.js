'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.
//
// A 429 from the per-IP limiter must leave a line in the tracker log: with a
// bare `message` option the library refused thousands of requests from one
// caller and the log stayed empty, so nobody could tell from the logs why
// that caller had stopped working. The handler is covered directly with an
// injected clock and sink, and once through the real base middleware so the
// wiring in src/api/startup.js is what is proven, not a label.

const { expect } = require('chai');
const express = require('express');
const supertest = require('supertest');

const { limitedHandler } = require('../../../src/server/rate_limit_log');
const { installBaseMiddleware } = require('../../../src/api/startup');

const MESSAGE = { error: 'Too many requests', code: 'RATE_LIMITED' };
const WINDOW_MS = 60000;

function makeRes() {
    return {
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; }
    };
}

function build(clock, lines, timers) {
    const opts = {
        service: 'UTXO tracker', name: 'per-IP', envVar: 'UTXO_TRACKER_RATE_LIMIT_RPM',
        limit: 500, windowMs: WINDOW_MS, message: MESSAGE,
        log: (line) => lines.push(line), now: () => clock.t
    };
    if (timers) {
        opts.setTimer = timers.setTimer;
        opts.clearTimer = timers.clearTimer;
    }
    return limitedHandler(opts);
}

// Manual timer queue on the same fake clock: advanceTo() moves the clock and
// fires every timer due by then, in order.
function fakeTimers(clock) {
    const pending = [];
    return {
        pending,
        setTimer(fn, ms) {
            const handle = { fn, at: clock.t + ms, unrefd: false, unref() { this.unrefd = true; return this; } };
            pending.push(handle);
            return handle;
        },
        clearTimer(handle) {
            const i = pending.indexOf(handle);
            if (i >= 0) pending.splice(i, 1);
        },
        advanceTo(t) {
            for (;;) {
                pending.sort((a, b) => a.at - b.at);
                if (!pending.length || pending[0].at > t) break;
                const h = pending.shift();
                clock.t = h.at;
                h.fn();
            }
            clock.t = t;
        }
    };
}

function parseLine(line) {
    const m = /: (\d+) requests? refused in the last (\d+) s/.exec(line);
    return { count: Number(m[1]), span: Number(m[2]) };
}

// Sends `count` sequential GET /status requests through the real base
// middleware at a limit of `rpm`, capturing console.warn: under the test
// bootstrap the module logger falls through to it.
async function driveRealLimiter(rpm, count) {
    const app = express();
    installBaseMiddleware(app, {
        installUnmatchedRouteLabel: () => {},
        CORS_ORIGIN: undefined,
        UTXO_TRACKER_RATE_LIMIT_RPM: String(rpm)
    });
    app.get('/status', (req, res) => res.json({ ok: true }));
    const warned = [];
    const statuses = [];
    const origWarn = console.warn;
    console.warn = (...args) => { warned.push(args.join(' ')); };
    const server = app.listen(0, '127.0.0.1');
    try {
        await new Promise((resolve) => server.once('listening', resolve));
        const agent = supertest(server);
        for (let i = 0; i < count; i++) statuses.push((await agent.get('/status')).status);
    } finally {
        console.warn = origWarn;
        await new Promise((resolve) => server.close(resolve));
    }
    return { statuses, warned };
}

describe('tracker rate-limit refusal logger', function () {
    it('answers 429 with the RATE_LIMITED body', function () {
        const handler = build({ t: 0 }, []);
        const res = makeRes();
        handler({}, res, () => {}, {});
        expect(res.statusCode).to.equal(429);
        expect(res.body).to.deep.equal(MESSAGE);
    });

    it('logs the first refusal, stays quiet inside the window, then logs the accumulated count', function () {
        const clock = { t: 1000 };
        const lines = [];
        const handler = build(clock, lines);

        handler({}, makeRes(), () => {}, {});
        expect(lines).to.have.length(1);
        expect(lines[0]).to.match(/rate limit/i);
        expect(lines[0]).to.contain('1 request refused');
        expect(lines[0]).to.contain('UTXO_TRACKER_RATE_LIMIT_RPM');

        for (let i = 0; i < 199; i++) {
            clock.t += 100;
            handler({}, makeRes(), () => {}, {});
        }
        expect(lines, 'a line per refusal would flood the log').to.have.length(1);

        clock.t = 1000 + WINDOW_MS;
        handler({}, makeRes(), () => {}, {});
        expect(lines).to.have.length(2);
        expect(lines[1]).to.contain('200 requests refused in the last 60 s');
    });
});

describe('tracker rate-limit refusal logger: burst tail flush', function () {
    it('logs the refusals of a burst tail when the window ends, with no later refusal', function () {
        const clock = { t: 0 };
        const lines = [];
        const timers = fakeTimers(clock);
        const handler = build(clock, lines, timers);

        // 100 refusals spread over 30 s from an idle start.
        for (let i = 0; i < 100; i++) {
            clock.t = Math.round(i * 30000 / 99);
            handler({}, makeRes(), () => {}, {});
        }
        expect(lines).to.have.length(1);

        timers.advanceTo(WINDOW_MS);
        const parsed = lines.map(parseLine);
        const total = parsed.reduce((sum, p) => sum + p.count, 0);
        expect(total, 'every refusal a client saw is accounted for in the log').to.equal(100);
        for (const p of parsed) expect(p.span).to.be.at.most(WINDOW_MS / 1000);
        expect(timers.pending, 'no timer stays armed once the tail is flushed').to.have.length(0);
    });

    it('a refusal long after a flushed burst logs a count of 1 over one window, not the idle gap', function () {
        const clock = { t: 0 };
        const lines = [];
        const timers = fakeTimers(clock);
        const handler = build(clock, lines, timers);

        for (let i = 0; i < 100; i++) {
            clock.t = i * 300;
            handler({}, makeRes(), () => {}, {});
        }
        timers.advanceTo(WINDOW_MS);
        const before = lines.length;

        timers.advanceTo(WINDOW_MS + 30 * 60 * 1000);
        expect(lines, 'an idle limiter writes nothing').to.have.length(before);
        handler({}, makeRes(), () => {}, {});
        expect(lines).to.have.length(before + 1);
        const last = parseLine(lines[lines.length - 1]);
        expect(last.count).to.equal(1);
        expect(last.span).to.be.at.most(WINDOW_MS / 1000);
    });
});

describe('tracker rate-limit refusal logger: steady refusals', function () {
    it('sustained refusals log once per window and every refusal is counted', function () {
        const clock = { t: 0 };
        const lines = [];
        const timers = fakeTimers(clock);
        const handler = build(clock, lines, timers);

        // One refusal every 100 ms for 5 minutes: 3000 refusals.
        for (let i = 0; i < 3000; i++) {
            timers.advanceTo(i * 100);
            handler({}, makeRes(), () => {}, {});
        }
        timers.advanceTo(3000 * 100 + WINDOW_MS);
        const parsed = lines.map(parseLine);
        expect(parsed.reduce((sum, p) => sum + p.count, 0)).to.equal(3000);
        expect(lines.length, 'about one line per window, not a line per refusal').to.be.at.most(7);
        for (const p of parsed) expect(p.span).to.be.at.most(WINDOW_MS / 1000);
    });

    it('arms its flush timer unref()d so an idle limiter never holds the process open', function () {
        const clock = { t: 0 };
        const timers = fakeTimers(clock);
        const handler = build(clock, [], timers);

        handler({}, makeRes(), () => {}, {});
        expect(timers.pending, 'a lone refusal that was already logged needs no timer').to.have.length(0);
        clock.t = 1000;
        handler({}, makeRes(), () => {}, {});
        expect(timers.pending).to.have.length(1);
        expect(timers.pending[0].unrefd).to.equal(true);
        timers.advanceTo(WINDOW_MS);
        expect(timers.pending).to.have.length(0);
    });
});

describe('tracker rate-limit refusal logger: wiring', function () {
    it('the real base middleware logs a rate limit line when it refuses a caller', async function () {
        const { statuses, warned } = await driveRealLimiter(2, 6);
        expect(statuses).to.deep.equal([200, 200, 429, 429, 429, 429]);
        const rateLines = warned.filter((l) => /rate limit/i.test(l));
        expect(rateLines, 'a refused caller left no trace in the tracker log').to.have.length(1);
        expect(rateLines[0]).to.contain('1 request refused');
    });
});
