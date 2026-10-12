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
            'invalid pagination cursor "bad-cursor" (expected "<txHash8Hex>:<vout>")'
        );
        expect(error.code).to.equal('INVALID_CURSOR');
        expect(error.data).to.deep.equal({ code: 'INVALID_CURSOR' });
    });

});
