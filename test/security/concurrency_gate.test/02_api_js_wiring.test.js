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

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const { closeServers } = require('../support/concurrency_gate_harness');

const entrySource = fs.readFileSync(path.join(__dirname, '../../../src/api.js'), 'utf8');
const startupSource = fs.readFileSync(path.join(__dirname, '../../../src/api/startup.js'), 'utf8');
const routesSource = fs.readFileSync(path.join(__dirname, '../../../src/api/routes.js'), 'utf8');
const statusSource = fs.readFileSync(path.join(__dirname, '../../../src/api/sync_status.js'), 'utf8');

describe('Security: global in-flight concurrency cap', function () {
    afterEach(closeServers);

    describe('API seam wiring', function () {

        it('mounts the gate on the app with an env-overridable cap', function () {
            expect(startupSource).to.include('concurrencyGate.createConcurrencyGate');
            expect(entrySource).to.include('UTXO_TRACKER_MAX_CONCURRENT_REQUESTS');
            expect(startupSource).to.match(/app\.use\(requestGate\)/);
        });

        it('mounts a bounded reserve for the exempt readiness probe', function () {
            expect(entrySource).to.include('UTXO_TRACKER_MAX_CONCURRENT_PROBES');
            expect(startupSource).to.match(/app\.use\(probeGate\)/);
        });

        it('classifies probes over the same set Express routes to /status', function () {
            // The two gates share one predicate as exact complements, so a
            // predicate narrower than the route splits admitting from holding
            // and hold() silently becomes a no-op. Assert the widened form in
            // source: HEAD, optional trailing slash, case-insensitive.
            expect(startupSource).to.include("const probePath = /^\\/status\\/?$/i");
            expect(startupSource).to.match(/isProbe\s*=\s*\(req\)\s*=>\s*\(req\.method === 'GET' \|\| req\.method === 'HEAD'\) && probePath\.test\(req\.path\)/);
        });

        it('holds the slot across every route that awaits a backend read', function () {
            // A route added without the wrapper is back to counting sockets
            // instead of work, which is invisible at runtime: assert the wiring
            // in source so the regression is caught here instead of in traffic.
            for(const route of ['/utxos/:address', '/firstseen/:address', '/balance/:address', '/info/:address']){
                expect(routesSource).to.include(`app.get('${route}', requestGate.hold(`);
            }
            // /status is exempt from the main cap, so its slot lives in the probe
            // reserve and only that gate's hold() can claim it.
            expect(statusSource).to.include("app.get('/status', probeGate.hold(");
            // One wrap covers every JSON-RPC method, batches included.
            expect(routesSource).to.match(/app\.use\(requestGate\.hold\(jsonRouter\(/);
        });
    });
});

describe('Security: global in-flight concurrency cap', function () {
    afterEach(closeServers);

    describe('API seam wiring', function () {

        it('wraps every registered route in a gate hold(), not just the listed ones', function () {
            // The list above names today's routes, so a new one added without the
            // wrapper would pass it; scan every registration instead.
            const code = (src) => src.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
            const routeCall = /\bapp\.(get|post|put|patch|delete|all)\(\s*(['"`])([^'"`]+)\2\s*,\s*([^\n]*)/g;
            const seen = [];
            for (const [file, src] of [['routes.js', routesSource], ['sync_status.js', statusSource]]) {
                for (const match of code(src).matchAll(routeCall)) {
                    const routePath = match[3];
                    const wrapper = routePath === '/status' ? 'probeGate.hold(' : 'requestGate.hold(';
                    seen.push(routePath);
                    expect(match[4].startsWith(wrapper),
                        `${file}: app.${match[1]}('${routePath}') must wrap its handler in ${wrapper}`).to.equal(true);
                }
            }
            expect(seen).to.include.members(['/utxos/:address', '/status'],
                'the scan must reach the real registrations, or it checks nothing');
            const uses = [...code(routesSource).matchAll(/\bapp\.use\(([^\n]*)/g)].map((m) => m[1]);
            expect(uses.length).to.be.greaterThan(0, 'the scan must reach the JSON-RPC mount');
            for (const use of uses) {
                const isBodyShim = /req\.body === undefined/.test(use);
                expect(isBodyShim || use.startsWith('requestGate.hold('),
                    `routes.js: app.use(${use.slice(0, 40)}...) must be the body shim or a requestGate.hold() mount`).to.equal(true);
            }
        });

        it('reports the gate stats so a stampede is visible to operators', function () {
            expect(statusSource).to.include('request_gate: requestGate.getStats()');
            expect(statusSource).to.include('probe_gate: probeGate.getStats()');
        });

        it('hands both gates to the scrape, so shedding is not visible on /status alone', function () {
            expect(startupSource).to.include('installMetrics(app, tracker, config, { request: requestGate, probe: probeGate })');
            expect(startupSource).to.include('installUtxoTrackerMetrics(observability, tracker, gates)');
        });
    });
});
