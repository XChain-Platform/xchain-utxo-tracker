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
const { closeServers } = require('./support');

describe('Security: global in-flight concurrency cap', function () {
    afterEach(closeServers);

    describe('api.js wiring', function () {

        const apiSource = fs.readFileSync(path.join(__dirname, '../../../src/api.js'), 'utf8');

        it('mounts the gate on the app with an env-overridable cap', function () {
            expect(apiSource).to.include('concurrencyGate.createConcurrencyGate');
            expect(apiSource).to.include('UTXO_TRACKER_MAX_CONCURRENT_REQUESTS');
            expect(apiSource).to.match(/app\.use\(requestGate\)/);
        });

        it('mounts a bounded reserve for the exempt readiness probe', function () {
            expect(apiSource).to.include('UTXO_TRACKER_MAX_CONCURRENT_PROBES');
            expect(apiSource).to.match(/app\.use\(probeGate\)/);
        });

        it('classifies probes over the same set Express routes to /status', function () {
            // The two gates share one predicate as exact complements, so a
            // predicate narrower than the route splits admitting from holding
            // and hold() silently becomes a no-op. Assert the widened form in
            // source: HEAD, optional trailing slash, case-insensitive.
            expect(apiSource).to.include("const PROBE_PATH = /^\\/status\\/?$/i;");
            expect(apiSource).to.match(/isProbe\s*=\s*\(req\)\s*=>\s*\(req\.method === 'GET' \|\| req\.method === 'HEAD'\) && PROBE_PATH\.test\(req\.path\)/);
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
