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
// The per-IP rate limiter keys on req.ip, and Express derives req.ip from
// X-Forwarded-For only as far as `trust proxy` allows. The tracker port is
// normally published directly, so trusting any hop by default lets a caller
// write its own limiter key and rotate past the limit one header per request.
// These tests drive the real base middleware: with no hop count configured a
// rotating X-Forwarded-For must still share one bucket, and with a declared
// hop the per-client buckets of the behind-a-proxy mode must still work.

const { expect } = require('chai');
const express = require('express');
const supertest = require('supertest');

const { installBaseMiddleware, resolveTrustProxyHops } = require('../../src/api/startup');

const LIMIT = 3;

function buildApp(extraConfig) {
    const app = express();
    installBaseMiddleware(app, {
        installUnmatchedRouteLabel: () => {},
        CORS_ORIGIN: undefined,
        UTXO_TRACKER_RATE_LIMIT_RPM: String(LIMIT),
        ...extraConfig
    });
    app.get('/status', (req, res) => res.json({ ok: true }));
    return app;
}

// Sends `count` sequential GET /status requests, each with a distinct forged
// X-Forwarded-For, and returns the responses in order.
async function sendRotating(app, count) {
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
        const agent = supertest(server);
        const responses = [];
        for (let j = 0; j < count; j++) {
            responses.push(await agent.get('/status').set('X-Forwarded-For', '10.88.' + (j >> 8) + '.' + (j & 255)));
        }
        return responses;
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

describe('tracker per-IP rate limiter and X-Forwarded-For', function () {
    it('a forged X-Forwarded-For does not grant a fresh bucket when no hop count is set', async function () {
        const responses = await sendRotating(buildApp({}), LIMIT + 2);
        const statuses = responses.map((r) => r.status);
        expect(statuses.slice(0, LIMIT)).to.deep.equal([200, 200, 200]);
        expect(statuses.slice(LIMIT), 'rotating X-Forwarded-For walked past the per-IP limit').to.deep.equal([429, 429]);
        for (const r of responses.slice(LIMIT)) expect(r.body.code).to.equal('RATE_LIMITED');
    });

    it('a declared hop count still gives each forwarded client its own bucket', async function () {
        const responses = await sendRotating(buildApp({ UTXO_TRACKER_TRUST_PROXY_HOPS: '1' }), LIMIT + 2);
        expect(responses.map((r) => r.status)).to.deep.equal([200, 200, 200, 200, 200]);
    });

    it('resolves the hop count to 0 by default and refuses values that would trust client entries', function () {
        expect(resolveTrustProxyHops(undefined)).to.equal(0);
        expect(resolveTrustProxyHops('')).to.equal(0);
        expect(resolveTrustProxyHops('0')).to.equal(0);
        expect(resolveTrustProxyHops('2')).to.equal(2);
        expect(resolveTrustProxyHops('80')).to.equal(0);
        expect(resolveTrustProxyHops('true')).to.equal(0);
        expect(resolveTrustProxyHops('-1')).to.equal(0);
    });
});
