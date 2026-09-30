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

// getRawTransaction classifies node faults the way its xchain-decoder twin does,
// because both feed the shared AuxPoW-reassembly path. The twin half skips when the
// sibling checkout is absent; set XCHAIN_REQUIRE_SIBLINGS=1 to make that a failure.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const transport = require('../../../src/chain/blockchain_connector/transport_and_mempool.js');

const DECODER_DIR = process.env.XCHAIN_DECODER_DIR || path.join(__dirname, '../../../../xchain-decoder');
const TWIN_FILE = path.join(DECODER_DIR, 'src', 'chain', 'blockchain_connector', 'transaction_queries.js');
const TWIN_PRESENT = fs.existsSync(TWIN_FILE);
const REQUIRE_SIBLINGS = process.env.XCHAIN_REQUIRE_SIBLINGS === '1';

const ok = (data) => () => ({ status: 200, data });
const fault = (fields, message = 'socket fault') => () => Object.assign(new Error(message), fields);
const rpc500 = (code) => fault({ response: { status: 500, data: { error: { code, message: 'rpc ' + code } } } },
    'Request failed with status code 500');
const times = (n, step) => Array.from({ length: n }, () => step);

// Each scenario scripts the node's answers in order; the last one repeats.
const SCENARIOS = {
    'hex on a 200 result':               { steps: [ok({ result: 'aa' })], kind: 'value', calls: 1, sleeps: [] },
    'null on an empty 200':              { steps: [ok({ result: null })], kind: 'null', calls: 1, sleeps: [] },
    'null on a 200 carrying RPC -5':     { steps: [ok({ result: null, error: { code: -5, message: 'gone' } })], kind: 'null', calls: 1, sleeps: [] },
    'null at once on an HTTP-500 -5':    { steps: [rpc500(-5)], kind: 'null', calls: 1, sleeps: [] },
    'retries a 200 carrying RPC -28':    { steps: [ok({ result: null, error: { code: -28, message: 'warming' } })], kind: 'reject', calls: 10, sleeps: times(10, 500) },
    'backs off 5s on a 200 -429':        { steps: [ok({ result: null, error: { code: -429, message: 'busy' } }), ok({ result: 'aa' })], kind: 'value', calls: 2, sleeps: [5000] },
    'backs off 5s on ECONNRESET':        { steps: [fault({ code: 'ECONNRESET' }), fault({ code: 'ECONNRESET' }), ok({ result: 'aa' })], kind: 'value', calls: 3, sleeps: [5000, 5000] },
    'backs off 5s on ECONNREFUSED':      { steps: [fault({ code: 'ECONNREFUSED' }), ok({ result: 'aa' })], kind: 'value', calls: 2, sleeps: [5000] },
    'backs off 5s on an HTTP-500 -429':  { steps: [rpc500(-429), ok({ result: 'aa' })], kind: 'value', calls: 2, sleeps: [5000] },
    'retries a timeout at 500ms':        { steps: [fault({ code: 'ECONNABORTED' }), ok({ result: 'aa' })], kind: 'value', calls: 2, sleeps: [500] },
    'rejects after 10 plain faults':     { steps: [fault({}, 'getaddrinfo ENOTFOUND node')], kind: 'reject', calls: 10, sleeps: times(10, 500) },
};

// Runs one scenario through a getRawTransaction implementation and records what it did.
async function drive(getRawTransaction, steps) {
    const sleeps = [];
    let calls = 0;
    const connector = {
        rpcErrors: 0,
        sleep: async (ms) => { sleeps.push(ms); },
        rpcPost: async () => {
            const step = steps[Math.min(calls++, steps.length - 1)]();
            if (step instanceof Error) throw step;
            return step;
        },
    };
    try {
        const value = await getRawTransaction.call(connector, 'txid-under-test');
        return { kind: value === null ? 'null' : 'value', calls, sleeps };
    } catch (err) {
        return { kind: 'reject', calls, sleeps, message: err.message };
    }
}

describe('getRawTransaction fault classification', function () {
    for (const [name, s] of Object.entries(SCENARIOS)) {
        it(name, async function () {
            const got = await drive(transport.getRawTransaction, s.steps);
            expect({ kind: got.kind, calls: got.calls, sleeps: got.sleeps })
                .to.deep.equal({ kind: s.kind, calls: s.calls, sleeps: s.sleeps });
        });
    }

    it('names the txid and the last cause when it gives up', async function () {
        const got = await drive(transport.getRawTransaction, SCENARIOS['rejects after 10 plain faults'].steps);
        expect(got.message).to.contain('txid-under-test').and.to.contain('ENOTFOUND');
    });
});

describe('getRawTransaction matches its xchain-decoder twin', function () {
    before(function () {
        if (TWIN_PRESENT) return;
        if (REQUIRE_SIBLINGS) throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but no decoder twin at ' + TWIN_FILE);
        this.skip();
    });

    for (const [name, s] of Object.entries(SCENARIOS)) {
        it(name, async function () {
            const twin = require(TWIN_FILE);
            const ours = await drive(transport.getRawTransaction, s.steps);
            const theirs = await drive(twin.getRawTransaction, s.steps);
            delete ours.message;
            delete theirs.message;
            expect(ours).to.deep.equal(theirs);
        });
    }
});
