'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// A malformed address is a caller mistake: it must get a bounded client error
// (HTTP 400 on REST, -32602 on JSON-RPC) and must not write an error-level log
// line with a stack. Classing it as an internal fault returned 500 / -32603 and
// let one client fill the error log with caller-chosen text at the rate limit,
// burying real faults. A genuine internal fault must still be a 500 / -32603
// with its error line, so the fix cannot mask real failures.

const { expect } = require('chai');
const sinon = require('sinon');
const supertest = require('supertest');
const { createTestApp } = require('./support/test_app');
const { captureLog } = require('../../helpers/capture_log');
const { sendAddressError } = require('../../../src/api/errors.js');
const { createTestTracker, closeTracker, TEST_KEYS } = require('../../integration/support/helpers');

const LONG_SEGMENT = 'A'.repeat(8000);

const BAD_ADDRESSES = [
    ['garbage', 'notanaddress'],
    ['mainnet bitcoin p2pkh on regtest', '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'],
    ['mainnet litecoin bech32 on regtest', 'ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgmn4n9'],
    ['8000-char segment', LONG_SEGMENT],
    ['CRLF embedded', 'abc\r\ndef'],
    ['unicode', 'mÅ☃Ａ'],
];

const ROUTES = ['/utxos/', '/balance/', '/info/', '/firstseen/'];
const RPC_METHODS = ['get_utxos', 'get_balance', 'get_info', 'get_first_seen', 'get_first_seen_status'];

function fakeRes() {
    const res = { statusCode: null, body: null };
    res.status = (s) => { res.statusCode = s; return res; };
    res.json = (b) => { res.body = b; return res; };
    return res;
}

// Shared across the registrations below; reset per test by registerLogHooks.
const ctx = { errorLines: [], release: null, tracker: null, app: null };

function registerLogHooks() {
    beforeEach(function () {
        ctx.errorLines = [];
        ctx.release = captureLog(['error'], (level, msg) => ctx.errorLines.push(msg));
    });
    afterEach(function () {
        ctx.release();
        sinon.restore();
    });
}

function registerSendAddressErrorTests() {
    describe('sendAddressError', function () {
        it('answers a BAD_REQUEST-coded invalid address with 400 and no error line', function () {
            const err = new Error('invalid address for this network');
            err.code = 'BAD_REQUEST';
            const res = fakeRes();
            sendAddressError(res, err);
            expect(res.statusCode).to.equal(400);
            expect(ctx.errorLines).to.have.length(0);
        });

        it('still answers an uncoded fault with 500 and an error line carrying the stack', function () {
            const res = fakeRes();
            sendAddressError(res, new Error('db failure'));
            expect(res.statusCode).to.equal(500);
            expect(ctx.errorLines).to.have.length(1);
            expect(ctx.errorLines[0]).to.include('db failure');
            expect(ctx.errorLines[0]).to.include('    at ');
        });
    });
}

function registerTrackerHooks() {
    beforeEach(async function () {
        ctx.tracker = await createTestTracker();
        ctx.tracker.blockchainInfoLastBlock = 1000;
        // getBalance: undefined restores the production balance path over the
        // real tracker instead of the harness's mock-only summing helper.
        ctx.app = createTestApp(ctx.tracker, '', { getBalance: undefined });
    });
    afterEach(async function () {
        await closeTracker(ctx.tracker);
    });
}

function rpc(method, params) {
    return supertest(ctx.app)
        .post('/')
        .set('Content-Type', 'application/json')
        .send({ jsonrpc: '2.0', id: 1, method, params });
}

function registerRestTests() {
    ROUTES.forEach((route) => {
        BAD_ADDRESSES.forEach(([label, addr]) => {
            it(`GET ${route}:address answers ${label} with 400 and logs no error`, async function () {
                const res = await supertest(ctx.app).get(route + encodeURIComponent(addr));
                expect(res.status, JSON.stringify(res.body).slice(0, 200)).to.equal(400);
                expect(res.body).to.have.property('code', 'BAD_REQUEST');
                // The body is bounded: the oversized input is not echoed back.
                expect(JSON.stringify(res.body).length).to.be.below(512);
                expect(ctx.errorLines, ctx.errorLines.join('\n')).to.have.length(0);
            });
        });
    });
}

function registerRpcTests() {
    RPC_METHODS.forEach((method) => {
        it(`JSON-RPC ${method} answers a malformed address with -32602`, async function () {
            const res = await rpc(method, { address: 'notanaddress' });
            expect(res.body.error, JSON.stringify(res.body)).to.be.an('object');
            expect(res.body.error.code).to.equal(-32602);
            expect(ctx.errorLines).to.have.length(0);
        });
    });

    it('JSON-RPC get_utxos answers a non-string or oversized address with -32602', async function () {
        const res = await rpc('get_utxos', { address: { a: 1 } });
        expect(res.body.error.code).to.equal(-32602);
        const long = await rpc('get_utxos', { address: LONG_SEGMENT });
        expect(long.body.error.code).to.equal(-32602);
        expect(JSON.stringify(long.body).length).to.be.below(512);
    });
}

function registerRealFaultTests() {
    it('a genuine store fault still answers 500 / -32603 and logs the error', async function () {
        sinon.stub(ctx.tracker.db, 'getOutputsScriptPubKey').rejects(new Error('store exploded'));
        const res = await supertest(ctx.app).get('/utxos/' + TEST_KEYS[0].address);
        expect(res.status).to.equal(500);
        expect(ctx.errorLines.some((l) => l.includes('store exploded'))).to.equal(true);
        const rpcRes = await rpc('get_utxos', { address: TEST_KEYS[0].address });
        expect(rpcRes.body.error.code).to.equal(-32603);
    });
}

describe('Malformed address is a client error, not an internal fault', function () {
    registerLogHooks();
    registerSendAddressErrorTests();
    describe('real tracker behind the API', function () {
        registerTrackerHooks();
        registerRestTests();
        registerRpcTests();
        registerRealFaultTests();
    });
});
