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
// A POST whose JSON body fails to parse (400) or exceeds the body limit (413)
// errors inside express.json. If the body parser runs before the per-IP limiter
// and the concurrency gates, those requests skip both: never counted, never
// refused with 429. These tests drive the real createApp stack.

const { expect } = require('chai');
const sinon = require('sinon');
const http = require('http');
const supertest = require('supertest');

const { createTestApp, createMockTracker } = require('../../unit/api.test/support/test_app.js');

const LIMIT = 3;

function post(app, body) {
    return supertest(app).post('/').set('Content-Type', 'application/json').send(body);
}

describe('tracker body parsing runs behind the limiter and gates', function () {
    it('counts and eventually refuses malformed-JSON POSTs', async function () {
        const app = createTestApp(createMockTracker(sinon), '', { UTXO_TRACKER_RATE_LIMIT_RPM: LIMIT });
        const res = [];
        for (let i = 0; i < LIMIT + 2; i++) res.push(await post(app, '{'));
        for (const r of res.slice(0, LIMIT)) {
            expect(r.status).to.equal(400);
            expect(r.body.error.code).to.equal(-32700);
        }
        for (const r of res.slice(LIMIT)) {
            expect(r.status).to.equal(429);
            expect(r.body.code).to.equal('RATE_LIMITED');
        }
    });

    it('counts and eventually refuses oversize POSTs, with RateLimit headers on the 413', async function () {
        const app = createTestApp(createMockTracker(sinon), '', { UTXO_TRACKER_RATE_LIMIT_RPM: LIMIT });
        const big = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'x', params: ['a'.repeat(150 * 1024)] });
        const res = [];
        for (let i = 0; i < LIMIT + 1; i++) res.push(await post(app, big));
        for (const r of res.slice(0, LIMIT)) expect(r.status).to.equal(413);
        expect(Number(res[0].headers['ratelimit-remaining'])).to.equal(LIMIT - 1);
        expect(Number(res[1].headers['ratelimit-remaining'])).to.equal(LIMIT - 2);
        expect(res[LIMIT].status).to.equal(429);
    });

});

describe('tracker body parsing runs behind the limiter and gates', function () {
    it('sheds a malformed-body POST with SERVER_BUSY while the concurrency cap is held', async function () {
        const tracker = createMockTracker(sinon);
        let release;
        const held = new Promise((resolve) => { release = resolve; });
        tracker.getUtxosAddress.callsFake(() => held.then(() => []));
        const app = createTestApp(tracker, '', { UTXO_TRACKER_MAX_CONCURRENT_REQUESTS: 1 });
        const server = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        try {
            const port = server.address().port;
            const inflight = new Promise((resolve) => {
                http.get({ host: '127.0.0.1', port, path: '/utxos/addr' }, (r) => { r.resume(); r.on('end', resolve); });
            });
            // Wait until the held request occupies the single slot.
            for (let i = 0; i < 100 && tracker.getUtxosAddress.callCount === 0; i++) {
                await new Promise((r) => setTimeout(r, 10));
            }
            expect(tracker.getUtxosAddress.callCount, 'held request never started').to.be.greaterThan(0);
            const r = await post(server, '{');
            expect(r.status).to.equal(429);
            expect(r.body.code).to.equal('SERVER_BUSY');
            release();
            await inflight;
        } finally {
            release();
            await new Promise((resolve) => server.close(resolve));
        }
    });

    it('still parses and routes a well-formed JSON-RPC call', async function () {
        const app = createTestApp(createMockTracker(sinon), '', { UTXO_TRACKER_RATE_LIMIT_RPM: LIMIT });
        const r = await post(app, JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'getbootstrap', params: [] }));
        expect(r.status).to.equal(401);
        expect(r.body.error.code).to.equal(-32001);
        const ok = await post(app, JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'nosuchmethod', params: [] }));
        expect(ok.status).to.not.equal(400);
        expect(ok.status).to.not.equal(413);
    });
});
