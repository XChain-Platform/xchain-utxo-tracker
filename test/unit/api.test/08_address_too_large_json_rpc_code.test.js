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

// An unpaged read of an address past the output ceiling is a caller mistake.
// REST answers 413; JSON-RPC must answer a numeric -32602 with the string code
// in data.code. The router coerces err.code with Number(), so an unmapped
// string code left as error.code null, which is not a JSON-RPC 2.0 code.

const { expect } = require('chai');
const sinon = require('sinon');
const supertest = require('supertest');
const { createTestApp, createMockTracker } = require('./support/test_app');
const { AddressTooLargeError } = require('../../../src/store/level_up_db/store_errors');

const ADDRESS = 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080';
const METHODS = ['get_utxos', 'get_balance', 'get_info'];

describe('ADDRESS_TOO_LARGE on JSON-RPC', function () {
    let tracker;
    let app;

    beforeEach(function () {
        tracker = createMockTracker(sinon);
        tracker.getUtxosAddress.rejects(new AddressTooLargeError(500000));
        tracker.getBalanceInfo.rejects(new AddressTooLargeError(500000));
        app = createTestApp(tracker);
    });
    afterEach(function () { sinon.restore(); });

    const post = (body) => supertest(app).post('/').set('Content-Type', 'application/json').send(body);
    const call = (method, id = 1) => ({ jsonrpc: '2.0', id, method, params: { address: ADDRESS } });

    function expectTooLarge(error) {
        expect(error, 'error object').to.be.an('object');
        expect(error.code).to.be.a('number');
        expect(error.code).to.equal(-32602);
        expect(error.data).to.have.property('code', 'ADDRESS_TOO_LARGE');
    }

    METHODS.forEach((method) => {
        it(`${method} answers -32602 with data.code ADDRESS_TOO_LARGE`, async function () {
            const res = await post(call(method));
            expectTooLarge(res.body.error);
        });
    });

    it('a batch of all three answers -32602 for each entry', async function () {
        const res = await post(METHODS.map((m, i) => call(m, i + 1)));
        expect(res.body).to.have.length(3);
        res.body.forEach((entry) => expectTooLarge(entry.error));
    });

    it('REST still answers 413 with code ADDRESS_TOO_LARGE', async function () {
        for (const route of ['/utxos/', '/balance/', '/info/']) {
            const res = await supertest(app).get(route + ADDRESS);
            expect(res.status, route).to.equal(413);
            expect(res.body).to.have.property('code', 'ADDRESS_TOO_LARGE');
        }
    });

    it('a genuine internal fault still leaves as -32603', async function () {
        tracker.getUtxosAddress.rejects(new Error('db failure'));
        const res = await post(call('get_utxos'));
        expect(res.body.error.code).to.equal(-32603);
    });
});
