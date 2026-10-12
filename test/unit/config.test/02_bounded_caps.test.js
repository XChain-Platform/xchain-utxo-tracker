/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 *********************************************************************/

'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const config = require('../../../src/config');
const { getLogger } = require('../../../src/observability');

// Each serving and sync cap, the knob that sets it, and its fail-safe default.
const CAPS = [
    { getter: 'MAX_BLOCK_FETCH_RETRIES', key: 'XCHAIN_MAX_BLOCK_FETCH_RETRIES', fallback: 20 },
    { getter: 'MAX_ADDRESS_OUTPUTS', key: 'UTXO_MAX_ADDRESS_OUTPUTS', fallback: 500000 },
    { getter: 'NODE_RPC_TIMEOUT_MS', key: 'NODE_RPC_TIMEOUT', fallback: 30000 },
    { getter: 'MAX_JSONRPC_BATCH', key: 'UTXO_MAX_RPC_BATCH', fallback: 20 },
    { getter: 'MAX_PAGE_LIMIT', key: 'UTXO_MAX_PAGE_LIMIT', fallback: 10000 },
];
const MALFORMED = ['Infinity', '0.5', '2.5', '0', '-3', 'abc', '12garbage'];

function withEnv(key, value, fn) {
    const had = Object.prototype.hasOwnProperty.call(process.env, key);
    const prev = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    try {
        return fn();
    } finally {
        if (had) process.env[key] = prev;
        else delete process.env[key];
    }
}

describe('config bounded caps resolve through the strict integer reader', function () {
    let errorStub;

    beforeEach(function () {
        errorStub = sinon.stub(getLogger(), 'error');
    });

    afterEach(function () {
        errorStub.restore();
    });

    it('defaults each cap silently when its knob is unset', function () {
        for (const { getter, key, fallback } of CAPS) {
            withEnv(key, undefined, () => expect(config[getter], getter).to.equal(fallback));
        }
        expect(errorStub.called).to.equal(false);
    });

    it('takes a valid integer override verbatim', function () {
        for (const { getter, key } of CAPS) {
            withEnv(key, '50', () => expect(config[getter], getter).to.equal(50));
        }
    });

    it('keeps the default and warns naming the knob on every malformed value', function () {
        for (const { getter, key, fallback } of CAPS) {
            for (const raw of MALFORMED) {
                errorStub.resetHistory();
                withEnv(key, raw, () => expect(config[getter], getter + '=' + raw).to.equal(fallback));
                expect(errorStub.calledOnce, key + '=' + raw + ' should warn').to.equal(true);
                expect(String(errorStub.firstCall.args[0])).to.include(key);
            }
        }
    });

    it('never resolves a fractional page limit to zero, which would unpage the query', function () {
        withEnv('UTXO_MAX_PAGE_LIMIT', '0.5', () => expect(config.MAX_PAGE_LIMIT).to.equal(10000));
    });

    it('never lifts the batch cap to Infinity', function () {
        withEnv('UTXO_MAX_RPC_BATCH', 'Infinity', () => expect(config.MAX_JSONRPC_BATCH).to.equal(20));
    });
});
