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
// A request whose JSON body is still uploading must not hold a concurrency
// slot. Node keeps a slow upload open for its full requestTimeout (300 s by
// default), so if the gates admit a request at its headers and the body is
// read behind them, a single client dripping a few bytes on a handful of
// sockets fills the main cap or the /status probe reserve and every other
// caller, the tracker's own healthcheck included, gets 429 SERVER_BUSY.

const { expect } = require('chai');
const sinon = require('sinon');
const net = require('net');
const http = require('http');
const { createTestApp, createMockTracker } = require('./support/test_app');

const MAIN_CAP = 3;
const PROBE_CAP = 2;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// Headers plus the first byte of a 1000-byte JSON body, then nothing more.
function openStalled(port, requestLine) {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', () => {
            socket.write(requestLine + '\r\nHost: t\r\nContent-Type: application/json\r\n' +
                'Content-Length: 1000\r\n\r\n{');
            resolve(socket);
        });
        socket.on('error', () => {});
        socket.once('error', reject);
    });
}

function request(port, method, path, body) {
    return new Promise((resolve, reject) => {
        const headers = body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {};
        const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
            let text = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { text += c; });
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(text); } catch { /* non-JSON body */ }
                resolve({ status: res.statusCode, body: json });
            });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

async function startServer() {
    const tracker = createMockTracker(sinon);
    tracker.getUtxosAddress.resolves([]);
    const app = createTestApp(tracker, '', {
        UTXO_TRACKER_MAX_CONCURRENT_REQUESTS: MAIN_CAP,
        UTXO_TRACKER_MAX_CONCURRENT_PROBES: PROBE_CAP
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    return { server, port: server.address().port, sockets: [] };
}

async function stopServer({ server, sockets }) {
    for (const s of sockets) s.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
}

async function mainCapStaysFree(ctx) {
    const { port } = ctx;
    for (let i = 0; i < MAIN_CAP + 2; i++) ctx.sockets.push(await openStalled(port, 'POST / HTTP/1.1'));
    await sleep(300);

    const utxos = await request(port, 'GET', '/utxos/addr');
    expect(utxos.status, 'REST read shed behind stalled uploads').to.equal(200);

    const rpc = await request(port, 'POST', '/',
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getbootstrap', params: [] }));
    // 401 means the call was admitted and reached the admin guard; 429 would mean shed.
    expect(rpc.status, 'JSON-RPC call shed behind stalled uploads').to.equal(401);

    const status = await request(port, 'GET', '/status');
    expect(status.status).to.not.equal(429);
    expect(status.body.request_gate.in_flight, 'stalled uploads counted as in flight').to.equal(0);
    expect(status.body.request_gate.shed).to.equal(0);
}

async function probeReserveStaysFree(ctx) {
    const { port } = ctx;
    for (let i = 0; i < PROBE_CAP + 2; i++) ctx.sockets.push(await openStalled(port, 'GET /status HTTP/1.1'));
    await sleep(300);

    const status = await request(port, 'GET', '/status');
    expect(status.status, 'healthcheck shed behind stalled uploads').to.not.equal(429);
    // Only the probe reading these stats holds a reserve slot.
    expect(status.body.probe_gate.in_flight).to.equal(1);
    expect(status.body.probe_gate.shed).to.equal(0);
}

// A body that stalls and then completes is still parsed and routed.
async function completedBodyIsServed(ctx) {
    const socket = await openStalled(ctx.port, 'POST / HTTP/1.1');
    ctx.sockets.push(socket);
    let reply = '';
    socket.on('data', (c) => { reply += c.toString('utf8'); });
    await sleep(100);
    // Finish the 1000-byte body: '{' plus padding plus '}' is a JSON object.
    socket.write(' '.repeat(998) + '}');
    for (let i = 0; i < 100 && !reply.includes('\r\n\r\n'); i++) await sleep(20);
    const statusLine = reply.split('\r\n')[0];
    expect(statusLine).to.match(/^HTTP\/1\.1 \d{3}/);
    expect(statusLine).to.not.match(/ (400|413|429) /);
}

describe('stalled JSON body uploads hold no concurrency slot', function () {
    this.timeout(20000);
    let ctx;
    beforeEach(async function () { ctx = await startServer(); });
    afterEach(async function () { await stopServer(ctx); });

    it('leaves the main cap free for other callers while POST bodies stall', () => mainCapStaysFree(ctx));
    it('leaves the /status probe reserve free while GET /status bodies stall', () => probeReserveStaysFree(ctx));
    it('still answers a stalled body once it completes', () => completedBodyIsServed(ctx));
});
