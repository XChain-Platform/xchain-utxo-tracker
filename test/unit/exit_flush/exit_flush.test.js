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

// Every deliberate exit gives the log shipper one bounded chance to send what it
// holds, so the drain's last line and a CRASH record reach the collector.

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const { createLogShipper } = require('../../../src/observability/logShipper');
const { registerLogFlush, flushLogs, exitAfterFlush } = require('../../../src/server/exit_flush');
const { createShutdown } = require('../../../src/server/shutdown');

const quiet = { log() {}, warn() {}, error() {} };
const SHIP_ENV = { LOG_SHIP_ENABLED: '1', LOG_SHIP_URL: 'http://127.0.0.1:9/ingest' };

function makeShipper(transport) {
    return createLogShipper({ service: 'svc', env: SHIP_ENV, console: quiet, transport });
}

function resetFlush() {
    afterEach(function () { registerLogFlush(null); });
}

describe('exit flush', function () {
    resetFlush();

    it('ships buffered lines before the exit seam runs', async function () {
        const bodies = [];
        const events = [];
        const shipper = makeShipper(async (body) => { bodies.push(body); events.push('ship'); });
        registerLogFlush(() => shipper.stop());
        shipper.error('CRASH', { kind: 'pollingLoopTerminated' });
        shipper.info('Shutdown drain complete; exiting.');
        expect(bodies).to.have.length(0);
        await exitAfterFlush(1, { exit: (code) => events.push('exit ' + code) });
        expect(events).to.deep.equal(['ship', 'exit 1']);
        expect(bodies.join('')).to.include('pollingLoopTerminated').and.to.include('Shutdown drain complete');
    });

    it('ships the batch queued behind a send already in flight', async function () {
        const bodies = [];
        let release;
        const first = new Promise((resolve) => { release = resolve; });
        const shipper = createLogShipper({
            service: 'svc', console: quiet,
            env: { ...SHIP_ENV, LOG_SHIP_BATCH_SIZE: '2' },
            transport: async (body) => { bodies.push(body); if (bodies.length === 1) await first; }
        });
        registerLogFlush(() => shipper.stop());
        shipper.info('a'); shipper.info('b');
        shipper.info('c');
        setTimeout(release, 20);
        await flushLogs(1000);
        expect(bodies.join('')).to.include('"msg":"c"');
    });

    it('exits after the bound when the collector never answers', async function () {
        const shipper = makeShipper(() => new Promise(() => {}));
        registerLogFlush(() => shipper.stop());
        shipper.info('held');
        const started = Date.now();
        const codes = [];
        await exitAfterFlush(0, { exit: (code) => codes.push(code), timeoutMs: 50 });
        expect(codes).to.deep.equal([0]);
        expect(Date.now() - started).to.be.lessThan(1000);
    });

    it('still exits when the flush throws, and when none is registered', async function () {
        const codes = [];
        registerLogFlush(() => { throw new Error('boom'); });
        await exitAfterFlush(1, { exit: (code) => codes.push(code) });
        registerLogFlush(null);
        await exitAfterFlush(0, { exit: (code) => codes.push(code) });
        expect(codes).to.deep.equal([1, 0]);
    });

});

describe('exit flush wiring', function () {
    resetFlush();

    it('carries the shutdown handler\'s own closing line to the collector', async function () {
        const bodies = [];
        const shipper = makeShipper(async (body) => { bodies.push(body); });
        registerLogFlush(() => shipper.stop());
        const exited = new Promise((resolve) => {
            const shutdown = createShutdown({
                drain: async () => {},
                log: { log: (m) => shipper.info(m), error: (m) => shipper.error(m) },
                exit: (code) => exitAfterFlush(code, { exit: resolve })
            });
            shutdown('SIGTERM');
        });
        expect(await exited).to.equal(0);
        expect(bodies.join('')).to.include('Shutdown drain complete; exiting.');
    });

    it('is the exit path of the entry point and of the steady-state drain', function () {
        const entry = fs.readFileSync(path.join(__dirname, '../../../src/api.js'), 'utf8');
        const startup = fs.readFileSync(path.join(__dirname, '../../../src/api/startup.js'), 'utf8');
        expect(entry).to.match(/noteCrash\('pollingLoopTerminated', err\)\s+await exitAfterFlush\(1\)/);
        expect(entry).to.match(/noteCrash\('bootFailed', err\)\s+return exitAfterFlush\(1\)/);
        expect(entry).to.not.match(/process\.exit\(1\)/);
        expect(startup).to.match(/exit: \(code\) => exitAfterFlush\(code\)/);
    });
});
