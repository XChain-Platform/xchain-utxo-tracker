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

const { expect } = require('chai');
const express = require('express');
const http = require('http');

const {
    Registry, Counter, Gauge, Histogram, collectDefaultMetrics
} = require('../../../src/observability/metrics.js');
const {
    installObservability, readObservabilityEnv, routeLabel
} = require('../../../src/observability/index.js');

// A console-shaped sink so tests never write to the mocha output.
function fakeConsole() {
    const lines = { log: [], warn: [], error: [] };
    return {
        lines,
        log:   (m) => lines.log.push(m),
        warn:  (m) => lines.warn.push(m),
        error: (m) => lines.error.push(m)
    };
}

async function listen(app) {
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    return {
        port,
        url: (p) => `http://127.0.0.1:${port}${p}`,
        close: () => new Promise((resolve) => server.close(resolve))
    };
}

function registerMetricDeclarationTests() {
    it('renders a counter with HELP, TYPE and labelled samples', function () {
        const reg = new Registry();
        const c = reg.counter({ name: 'test_requests_total', help: 'Requests', labelNames: ['route'] });
        c.inc({ route: '/a' }, 2);
        c.inc({ route: '/a' });
        c.inc({ route: '/b' });

        const out = reg.render();
        expect(out).to.include('# HELP test_requests_total Requests');
        expect(out).to.include('# TYPE test_requests_total counter');
        expect(out).to.include('test_requests_total{route="/a"} 3');
        expect(out).to.include('test_requests_total{route="/b"} 1');
        expect(out.endsWith('\n')).to.equal(true);
    });

    it('rejects invalid metric and label names at declaration', function () {
        const reg = new Registry();
        expect(() => reg.counter({ name: '9bad', help: 'x' })).to.throw(/invalid metric name/);
        expect(() => reg.counter({ name: 'ok_total', help: 'x', labelNames: ['bad-label'] })).to.throw(/invalid label name/);
        expect(() => reg.counter({ name: 'ok2_total', help: 'x', labelNames: ['__name__'] })).to.throw(/reserved/);
    });

    it('hands back the same metric when an identical declaration repeats', function () {
        // Modules register their counters wherever they are required, and the
        // registry is now process-wide, so an identical re-declaration is a
        // normal event rather than a conflict.
        const reg = new Registry();
        const first = reg.gauge({ name: 'dup_gauge', help: 'x' });
        expect(reg.gauge({ name: 'dup_gauge', help: 'y' })).to.equal(first);
    });

    it('still refuses a duplicate name declared with a different shape', function () {
        const reg = new Registry();
        reg.gauge({ name: 'shape_clash', help: 'x' });
        expect(() => reg.counter({ name: 'shape_clash', help: 'x' })).to.throw(/different shape/);
        reg.gauge({ name: 'label_clash', help: 'x', labelNames: ['a'] });
        expect(() => reg.gauge({ name: 'label_clash', help: 'x', labelNames: ['b'] })).to.throw(/different shape/);
    });

    it('rejects a negative counter increment and an unknown label', function () {
        const reg = new Registry();
        const c = reg.counter({ name: 'neg_total', help: 'x', labelNames: ['a'] });
        expect(() => c.inc({ a: '1' }, -1)).to.throw(/non-negative/);
        expect(() => c.inc({ b: '1' }, 1)).to.throw(/unknown label/);
    });
}

function registerMetricRenderingTests() {
    it('escapes backslash, quote and newline in label values and help', function () {
        const reg = new Registry();
        const c = reg.counter({ name: 'esc_total', help: 'line1\nline2 \\ end', labelNames: ['v'] });
        c.inc({ v: 'a"b\\c\nd' });
        const out = reg.render();
        expect(out).to.include('# HELP esc_total line1\\nline2 \\\\ end');
        expect(out).to.include('esc_total{v="a\\"b\\\\c\\nd"} 1');
        // No raw newline may appear inside a sample line.
        for (const line of out.trim().split('\n')) expect(line).to.not.equal('');
    });

    it('treats label order as declared order, not caller order', function () {
        const reg = new Registry();
        const c = reg.counter({ name: 'order_total', help: 'x', labelNames: ['a', 'b'] });
        c.inc({ a: '1', b: '2' });
        c.inc({ b: '2', a: '1' });
        expect(c.get({ a: '1', b: '2' })).to.equal(2);
        expect(reg.render().split('\n').filter((l) => l.startsWith('order_total{')).length).to.equal(1);
    });

    it('emits cumulative histogram buckets with +Inf equal to _count', function () {
        const reg = new Registry();
        const h = reg.histogram({ name: 'lat_seconds', help: 'x', labelNames: ['route'], buckets: [0.1, 0.5, 1] });
        h.observe({ route: '/a' }, 0.05);
        h.observe({ route: '/a' }, 0.3);
        h.observe({ route: '/a' }, 2);

        const out = reg.render();
        expect(out).to.include('# TYPE lat_seconds histogram');
        expect(out).to.include('lat_seconds_bucket{route="/a",le="0.1"} 1');
        expect(out).to.include('lat_seconds_bucket{route="/a",le="0.5"} 2');
        expect(out).to.include('lat_seconds_bucket{route="/a",le="1"} 2');
        expect(out).to.include('lat_seconds_bucket{route="/a",le="+Inf"} 3');
        expect(out).to.include('lat_seconds_count{route="/a"} 3');
        expect(out).to.include('lat_seconds_sum{route="/a"} 2.35');
    });

    it('ignores a non-finite histogram observation instead of poisoning the sum', function () {
        const reg = new Registry();
        const h = reg.histogram({ name: 'nan_seconds', help: 'x', buckets: [1] });
        h.observe({}, Number.NaN);
        h.observe({}, Infinity);
        h.observe({}, 0.5);
        expect(h.get({}).count).to.equal(1);
        expect(h.get({}).sum).to.equal(0.5);
    });
}

function registerMetricStateTests() {
    it('reserves le for histogram buckets', function () {
        const reg = new Registry();
        expect(() => reg.histogram({ name: 'le_seconds', help: 'x', labelNames: ['le'] })).to.throw(/reserved/);
    });

    it('caps series per metric and counts the drops instead of growing', function () {
        const reg = new Registry({ maxSeries: 3 });
        const c = reg.counter({ name: 'card_total', help: 'x', labelNames: ['id'] });
        for (let i = 0; i < 10; i++) c.inc({ id: `id-${i}` });
        expect(c.series.size).to.equal(3);
        expect(reg.get('xchain_metrics_series_dropped_total').get({ metric: 'card_total' })).to.equal(7);
        expect(reg.render()).to.include('xchain_metrics_series_dropped_total{metric="card_total"} 7');
    });

    it('gauge set/inc/dec track a value and reject a non-finite set', function () {
        const reg = new Registry();
        const g = reg.gauge({ name: 'depth', help: 'x' });
        g.set({}, 5);
        g.inc({}, 2);
        g.dec({}, 3);
        expect(g.get({})).to.equal(4);
        expect(() => g.set({}, Number.NaN)).to.throw(/finite/);
    });

    it('setMonotonic never lets a collector-driven counter go backwards', function () {
        const reg = new Registry();
        const c = reg.counter({ name: 'cpu_total', help: 'x' });
        c.setMonotonic({}, 10);
        c.setMonotonic({}, 4);
        expect(c.get({})).to.equal(10);
    });

    it('survives a throwing collector and still renders the rest', function () {
        const reg = new Registry();
        reg.counter({ name: 'ok_total', help: 'x' }).inc({});
        reg.addCollector(() => { throw new Error('boom'); });
        expect(reg.render()).to.include('ok_total 1');
    });

    it('collectDefaultMetrics exposes process and service identity', function () {
        const reg = new Registry();
        collectDefaultMetrics(reg, { service: 'xchain-utxo-tracker', version: '1.2.3', coin: 'BTC', network: 'regtest' });
        const out = reg.render();
        expect(out).to.include('xchain_service_info{service="xchain-utxo-tracker",version="1.2.3",coin="BTC",network="regtest"');
        expect(out).to.match(/process_resident_memory_bytes \d+/);
        expect(out).to.match(/process_cpu_user_seconds_total [\d.]+/);
        expect(out).to.include('# TYPE process_cpu_user_seconds_total counter');
        expect(out).to.match(/nodejs_heap_size_used_bytes \d+/);
    });

    it('exports the Prometheus content type', function () {
        expect(new Registry().contentType()).to.equal('text/plain; version=0.0.4; charset=utf-8');
    });
    it('metric classes are usable standalone', function () {
        expect(new Counter({ name: 'a_total', help: 'x' }).inc({}, 2)).to.equal(2);
        const g = new Gauge({ name: 'b', help: 'x' }); g.set({}, 1); expect(g.get({})).to.equal(1);
        const h = new Histogram({ name: 'c', help: 'x' }); h.observe({}, 1); expect(h.get({}).count).to.equal(1);
    });
}

function registerInstallConfigTests() {
    it('reads a default-off config from an empty env', function () {
        const cfg = readObservabilityEnv({});
        expect(cfg.metricsEnabled).to.equal(false);
        expect(cfg.httpMetrics).to.equal(false);
        expect(cfg.metricsPath).to.equal('/metrics');
        expect(cfg.log.shipEnabled).to.equal(false);
    });

    it('normalizes a METRICS_PATH given without a leading slash', function () {
        expect(readObservabilityEnv({ METRICS_ENABLED: '1', METRICS_PATH: 'internal/metrics' }).metricsPath)
            .to.equal('/internal/metrics');
    });
}

function registerInstallEndpointTests() {
    it('registers NO route when the flag is unset, but still hands back a registry', async function () {
        const app = express();
        app.get('/health', (req, res) => res.json({ ok: true }));
        const obs = installObservability(app, { service: 'xchain-utxo-tracker', env: {}, console: fakeConsole() });
        expect(obs.enabled).to.equal(false);
        // The registry is deliberately NOT gated: a counter a consensus module
        // registers has to exist on the default fleet, or it can never record.
        // Only the endpoint is an operator decision.
        expect(obs.registry).to.not.equal(null);
        expect(typeof obs.registry.counter).to.equal('function');

        const srv = await listen(app);
        try {
            const res = await fetch(srv.url('/metrics'));
            expect(res.status).to.equal(404);
        } finally {
            await obs.shutdown();
            await srv.close();
        }
    });

    it('serves the exposition text and instruments requests when enabled', async function () {
        const app = express();
        app.get('/health', (req, res) => res.json({ ok: true }));
        const obs = installObservability(app, {
            service: 'xchain-utxo-tracker', version: '1.0.0', coin: 'BTC', network: 'regtest',
            env: { METRICS_ENABLED: '1' }, console: fakeConsole()
        });
        expect(obs.enabled).to.equal(true);

        const srv = await listen(app);
        try {
            await fetch(srv.url('/health'));
            await fetch(srv.url('/health'));
            await fetch(srv.url('/nope'));

            const res = await fetch(srv.url('/metrics'));
            expect(res.status).to.equal(200);
            expect(res.headers.get('content-type')).to.include('version=0.0.4');
            expect(res.headers.get('cache-control')).to.equal('no-store');

            const body = await res.text();
            expect(body).to.include('http_requests_total{method="GET",route="/health",status="200"} 2');
            expect(body).to.include('http_request_duration_seconds_count{method="GET",route="/health"} 2');
            expect(body).to.include('http_requests_in_flight 0');
            expect(body).to.include('xchain_service_info{service="xchain-utxo-tracker",version="1.0.0",coin="BTC",network="regtest"');
            // The scrape itself is never counted.
            expect(body).to.not.include('route="/metrics"');
        } finally {
            await obs.shutdown();
            await srv.close();
        }
    });
}

function registerRouteLabelTests() {
    it('buckets an unmatched path by first segment so URLs cannot explode cardinality', async function () {
        const app = express();
        const obs = installObservability(app, { service: 'svc', env: { METRICS_ENABLED: '1' }, console: fakeConsole() });
        const srv = await listen(app);
        try {
            await fetch(srv.url('/block/000000001'));
            await fetch(srv.url('/block/000000002'));
            const body = await (await fetch(srv.url('/metrics'))).text();
            expect(body).to.include('http_requests_total{method="GET",route="/block",status="404"} 2');
        } finally {
            await obs.shutdown();
            await srv.close();
        }
    });

    it('uses the express route pattern, not the concrete path, as the route label', function () {
        expect(routeLabel({ route: { path: '/snapshot/:table' }, baseUrl: '/hub-db' })).to.equal('/hub-db/snapshot/:table');
        expect(routeLabel({ originalUrl: '/telemetry/summary?x=1' })).to.equal('/telemetry');
        expect(routeLabel({ url: '/' })).to.equal('/');
    });

    it('gates the endpoint behind METRICS_TOKEN when one is configured', async function () {
        const app = express();
        const obs = installObservability(app, {
            service: 'svc', env: { METRICS_ENABLED: '1', METRICS_TOKEN: 'sekret-scrape' }, console: fakeConsole()
        });
        const srv = await listen(app);
        try {
            expect((await fetch(srv.url('/metrics'))).status).to.equal(401);
            expect((await fetch(srv.url('/metrics'), { headers: { Authorization: 'Bearer wrong' } })).status).to.equal(401);
            const ok = await fetch(srv.url('/metrics'), { headers: { Authorization: 'Bearer sekret-scrape' } });
            expect(ok.status).to.equal(200);
            expect(await ok.text()).to.include('# TYPE');
        } finally {
            await obs.shutdown();
            await srv.close();
        }
    });
}

function registerCustomRouteTests() {
    it('honours a custom METRICS_PATH and can skip HTTP instrumentation', async function () {
        const app = express();
        app.get('/health', (req, res) => res.json({ ok: true }));
        const obs = installObservability(app, {
            service: 'svc', env: { METRICS_ENABLED: '1', METRICS_PATH: '/internal/metrics', METRICS_HTTP: '0' },
            console: fakeConsole()
        });
        const srv = await listen(app);
        try {
            await fetch(srv.url('/health'));
            expect((await fetch(srv.url('/metrics'))).status).to.equal(404);
            const body = await (await fetch(srv.url('/internal/metrics'))).text();
            expect(body).to.include('xchain_service_info');
            expect(body).to.not.include('http_requests_total{');
        } finally {
            await obs.shutdown();
            await srv.close();
        }
    });

    it('instruments routes registered BEFORE the install call (layer is hoisted)', async function () {
        // The six services wire this at different points in their api.js; Express
        // dispatches in registration order, so without the hoist an install that
        // lands after the routes would export zero HTTP metrics.
        const app = express();
        app.get('/early', (req, res) => res.send('ok'));
        const obs = installObservability(app, { service: 'svc', env: { METRICS_ENABLED: '1' }, console: fakeConsole() });
        const srv = await listen(app);
        try {
            await fetch(srv.url('/early'));
            const body = await (await fetch(srv.url('/metrics'))).text();
            expect(body).to.include('http_requests_total{method="GET",route="/early",status="200"} 1');
        } finally {
            await obs.shutdown();
            await srv.close();
        }
    });

    it('returns a usable logger even with no app to mount on', function () {
        const sink = fakeConsole();
        const obs = installObservability(null, { service: 'worker', env: {}, console: sink });
        expect(obs.enabled).to.equal(false);
        obs.logger.info('tick');
        expect(sink.lines.log).to.have.lengthOf(1);
        expect(sink.lines.log[0]).to.match(/^\S+Z info \[worker\] tick$/);
    });
}

module.exports = {
    registerMetricDeclarationTests,
    registerMetricRenderingTests,
    registerMetricStateTests,
    registerInstallConfigTests,
    registerInstallEndpointTests,
    registerRouteLabelTests,
    registerCustomRouteTests
};
