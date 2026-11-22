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

const { expect } = require('chai');
const {
    AddressTooLargeError,
    InvalidCursorError
} = require('../../../../src/store/level_up_db/store_errors');

describe('store_errors', function () {

    it('constructs an AddressTooLargeError with its pagination details', function () {
        const error = new AddressTooLargeError(500);

        expect(error).to.be.an.instanceOf(Error);
        expect(error).to.be.an.instanceOf(AddressTooLargeError);
        expect(error.name).to.equal('AddressTooLargeError');
        expect(error.message).to.equal(
            'address has more than 500 outputs; page the result with ?limit=&after='
        );
        expect(error.code).to.equal('ADDRESS_TOO_LARGE');
        expect(error.maxOutputs).to.equal(500);
        expect(error.data).to.deep.equal({ code: 'ADDRESS_TOO_LARGE' });
    });

    it('constructs an InvalidCursorError with its cursor details', function () {
        const error = new InvalidCursorError('bad-cursor');

        expect(error).to.be.an.instanceOf(Error);
        expect(error).to.be.an.instanceOf(InvalidCursorError);
        expect(error.name).to.equal('InvalidCursorError');
        expect(error.message).to.equal(
            'invalid pagination cursor "bad-cursor" (expected "<txid>:<vout>")'
        );
        expect(error.code).to.equal('INVALID_CURSOR');
        expect(error.data).to.deep.equal({ code: 'INVALID_CURSOR' });
    });

    it('bounds the echoed cursor so an oversized cursor gives a small error', function () {
        const error = new InvalidCursorError('z'.repeat(90000));

        expect(error.message.length).to.be.below(1024);
        expect(error.code).to.equal('INVALID_CURSOR');
        expect(error.data).to.deep.equal({ code: 'INVALID_CURSOR' });
        expect(JSON.stringify(error.message).length).to.be.below(1024);
    });

    it('bounds a non-string cursor echo too', function () {
        const error = new InvalidCursorError({ a: 'q'.repeat(50000) });

        expect(error.message.length).to.be.below(1024);
    });

    it('keeps a short cursor verbatim in the message', function () {
        const error = new InvalidCursorError('abc');

        expect(error.message).to.equal(
            'invalid pagination cursor "abc" (expected "<txid>:<vout>")'
        );
    });

});
