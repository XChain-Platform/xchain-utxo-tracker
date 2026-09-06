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
// The `route` label of the HTTP metrics is caller-controlled for any request
// that matches no declared route: the observability shim falls back to the
// request's first path segment. Each metric caps its distinct series, so a
// caller inventing paths can fill that cap with invented labels and the
// tracker's own routes are then dropped from the scrape. These tests drive the
// cap past its bound with invented paths and assert a real route still reaches
// /metrics.

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const express = require('express');
const supertest = require('supertest');

const { installUnmatchedRouteLabel, UNMATCHED_ROUTE_LABEL } = require('../../src/api');
const { installObservability, _resetObservability } = require('../../src/observability');
const { DEFAULT_MAX_SERIES } = require('../../src/observability/metrics');

// One invented path per series slot, plus a margin, so the cap is reached with
// junk alone and the real route below asks for a slot that is already gone.
const JUNK_PATHS = DEFAULT_MAX_SERIES + 20;

// Stands in for the rate limiter and the concurrency gates: middleware that
// answers a request before routing reaches any declared route.
const SHED_HEADER = 'x-force-shed';

// Builds the tracker's request stack: an optional unmatched-route label, then
// middleware that can shed, then a declared route. `installObservability` adds
// the real timing middleware and the real /metrics endpoint.
function buildStack({ bounded }) {
    const app = express();
    if (bounded) installUnmatchedRouteLabel(app);
    const observability = installObservability(app, {
        service: 'xchain-utxo-tracker',
        env: { ...process.env, METRICS_ENABLED: '1', METRICS_HTTP: '1', METRICS_TOKEN: '' }
    });
    app.use((req, res, next) => {
        if (req.headers[SHED_HEADER]) return res.status(429).json({ code: 'SERVER_BUSY' });
        next();
    });
    app.get('/utxos/:address', (req, res) => res.json([]));
    const server = app.listen(0);
    return { app, server, observability, agent: supertest(server) };
}

// Every `route="..."` value carried by http_requests_total in a scrape body.
function routeLabelsIn(body) {
    const labels = new Set();
    for (const line of body.split('\n')) {
        if (!line.startsWith('http_requests_total{')) continue;
        const m = /route="((?:[^"\\]|\\.)*)"/.exec(line);
        if (m) labels.add(m[1]);
    }
    return labels;
}

async function driveAndScrape(stack) {
    for (let i = 0; i < JUNK_PATHS; i++) {
        await stack.agent.get(`/${i}-not-a-route/deep`);
    }
    // Sheds too: an invented path that never reaches routing still gets labelled.
    await stack.agent.get('/shed-me/now').set(SHED_HEADER, '1');
    // The traffic an operator actually watches, asked for last.
    await stack.agent.get('/utxos/abc123');
    const res = await stack.agent.get('/metrics');
    expect(res.status).to.equal(200);
    return res.text;
}

describe('HTTP metric route labels stay bounded under invented paths @security', function () {
    this.timeout(120000);

    let stack = null;

    afterEach(function () {
        if (stack) {
            stack.observability.shutdown();
            stack.server.close();
            stack = null;
        }
        _resetObservability();
    });

    it('keeps a declared route on the scrape after the series cap is driven past', async function () {
        stack = buildStack({ bounded: true });
        const body = await driveAndScrape(stack);

        expect(body, 'the declared route lost its series to invented labels')
            .to.match(/http_requests_total\{[^}]*route="\/utxos\/:address"/);

        const labels = routeLabelsIn(body);
        expect(labels.has(UNMATCHED_ROUTE_LABEL), `no ${UNMATCHED_ROUTE_LABEL} series, so unmatched requests are still labelled by their path`)
            .to.equal(true);
        // The declared route, the collapsed unmatched route, and nothing a caller
        // can name. Bare `/` is reachable too, hence the small allowance.
        expect(labels.size, `route labels: ${[...labels].join(', ')}`).to.be.at.most(3);

        expect(body, 'observations were dropped, so a slot was still spent per invented path')
            .to.not.match(/xchain_metrics_series_dropped_total\{metric="http_requests_total"\} [1-9]/);
    });

    it('reproduces the unbounded label without the guard', async function () {
        stack = buildStack({ bounded: false });
        const body = await driveAndScrape(stack);

        const labels = routeLabelsIn(body);
        expect(labels.size, 'invented paths no longer mint one series each').to.be.at.least(DEFAULT_MAX_SERIES);
        expect(labels.has('/utxos/:address'), 'the declared route survived the cap without the guard').to.equal(false);
        expect(body).to.match(/xchain_metrics_series_dropped_total\{metric="http_requests_total"\} [1-9]/);
    });
});

describe('src/api.js mounts the unmatched-route label first @regression', function () {
    const SRC = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');

    it('installs the label on the app ahead of every middleware that can shed', function () {
        const create = SRC.indexOf('const app = express()');
        expect(create, 'src/api.js no longer creates the app with `const app = express()`').to.be.greaterThan(-1);

        // Searched from the app's creation so the function's own declaration,
        // which sits above it, is not mistaken for the call site.
        const mount = SRC.indexOf('installUnmatchedRouteLabel(app);', create);
        const helmet = SRC.indexOf('app.use(helmet())');

        expect(mount, 'src/api.js does not mount installUnmatchedRouteLabel, so invented paths mint a metric series each').to.be.greaterThan(create);
        expect(helmet, 'src/api.js no longer mounts helmet, so this ordering guard needs rewriting').to.be.greaterThan(-1);
        expect(mount, 'the unmatched-route label is mounted after middleware that can answer a request, so shed requests stay caller-labelled').to.be.lessThan(helmet);
    });
});
