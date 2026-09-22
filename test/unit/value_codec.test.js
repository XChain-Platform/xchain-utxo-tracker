/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
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
const { encodeOutput, decodeOutput } = require('../../src/store/level_up_db/value_codec');

const HEX64 = 'aa'.repeat(32);

describe('value_codec encodeOutput / decodeOutput', function () {

    it('round-trips a non-coinbase output', function () {
        const buf = encodeOutput('5000000000', 100, HEX64, false);
        expect(decodeOutput(buf)).to.deep.equal({ v: '5000000000', h: 100, t: HEX64, cb: false });
    });

    it('sets byte 44 for a coinbase output and decodes cb true', function () {
        const buf = encodeOutput('5000000000', 100, HEX64, true);
        expect(buf).to.have.length(45);
        expect(buf[44]).to.equal(1);
        expect(decodeOutput(buf).cb).to.be.true;
    });

    it('decodes an omitted hash as the null sentinel', function () {
        const buf = encodeOutput('5000000000', 100, null, false);
        expect(decodeOutput(buf).t).to.equal(null);
    });

});
