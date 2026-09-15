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

// Additional unit tests for LevelUpDb.js covering uncovered lines not reached
// by LevelUpDb.test.js. All stores use in-memory MemoryLevel (no disk).

const { expect } = require('chai');
const crypto = require('crypto');
const LevelUpStore = require('../../../src/store/level_up_db');

function randHash() { return crypto.randomBytes(32).toString('hex'); }
function randHash8() { return crypto.randomBytes(8).toString('hex'); }
function randBuf32() { return crypto.randomBytes(32); }

let dbCounter = 0;
function makeDb() {
    return new LevelUpStore('more-test-' + Date.now() + '-' + (++dbCounter), true);
}

describe('LevelUpDb (extended coverage)', function () {

    describe('exported error classes', function () {
        it('AddressTooLargeError has correct properties', function () {
            const err = new LevelUpStore.AddressTooLargeError(500);
            expect(err.name).to.equal('AddressTooLargeError');
            expect(err.code).to.equal('ADDRESS_TOO_LARGE');
            expect(err.maxOutputs).to.equal(500);
            expect(err.message).to.include('500');
        });

        it('InvalidCursorError has correct properties', function () {
            const err = new LevelUpStore.InvalidCursorError('bad-cursor');
            expect(err.name).to.equal('InvalidCursorError');
            expect(err.code).to.equal('INVALID_CURSOR');
            expect(err.message).to.include('bad-cursor');
        });
    });

});
