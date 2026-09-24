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

const OPEN_FILES_KEY = 'LEVELDB_MAX_OPEN_FILES';
const FILE_SIZE_KEY = 'LEVELDB_MAX_FILE_SIZE_BYTES';

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

describe('config LEVELDB_MAX_OPEN_FILES / LEVELDB_MAX_FILE_SIZE_BYTES', function () {
    let errorStub;

    beforeEach(function () {
        errorStub = sinon.stub(console, 'error');
    });

    afterEach(function () {
        errorStub.restore();
    });

    it('defaults to the classic-level engine defaults when unset', function () {
        withEnv(OPEN_FILES_KEY, undefined, () => {
            expect(config.LEVELDB_MAX_OPEN_FILES).to.equal(1000);
        });
        withEnv(FILE_SIZE_KEY, undefined, () => {
            expect(config.LEVELDB_MAX_FILE_SIZE_BYTES).to.equal(2 * 1024 * 1024);
        });
        expect(errorStub.called).to.equal(false);
    });

    it('takes an operator override verbatim', function () {
        withEnv(OPEN_FILES_KEY, '512', () => {
            expect(config.LEVELDB_MAX_OPEN_FILES).to.equal(512);
        });
        withEnv(FILE_SIZE_KEY, String(4 * 1024 * 1024), () => {
            expect(config.LEVELDB_MAX_FILE_SIZE_BYTES).to.equal(4 * 1024 * 1024);
        });
    });

    it('falls back to the default and warns on a malformed value', function () {
        withEnv(OPEN_FILES_KEY, 'not-a-number', () => {
            expect(config.LEVELDB_MAX_OPEN_FILES).to.equal(1000);
        });
        expect(errorStub.called).to.equal(true);
        expect(String(errorStub.firstCall.args[0])).to.include(OPEN_FILES_KEY);
    });

    it('falls back to the default rather than a knob at or below zero', function () {
        withEnv(OPEN_FILES_KEY, '0', () => {
            expect(config.LEVELDB_MAX_OPEN_FILES).to.equal(1000);
        });
        withEnv(FILE_SIZE_KEY, '-1', () => {
            expect(config.LEVELDB_MAX_FILE_SIZE_BYTES).to.equal(2 * 1024 * 1024);
        });
    });
});
