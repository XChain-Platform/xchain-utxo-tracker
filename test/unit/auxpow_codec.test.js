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

// Pin readVarint directly (the AuxPoW strip path walks untrusted block bytes with it).

const { expect } = require('chai');
const { readVarint, encodeVarintHex } = require('../../src/chain/blockchain_connector/auxpow_codec');

describe('auxpow_codec readVarint', function () {
    it('decodes a single-byte varint below 0xfd', function () {
        expect(readVarint(Buffer.from([0x00]), 0)).to.deep.equal({ value: 0, bytes: 1 });
        expect(readVarint(Buffer.from([0xfc]), 0)).to.deep.equal({ value: 0xfc, bytes: 1 });
    });

    it('decodes the 0xfd, 0xfe and 0xff prefixes with their widths', function () {
        expect(readVarint(Buffer.from([0xfd, 0xfd, 0x00]), 0)).to.deep.equal({ value: 0xfd, bytes: 3 });
        expect(readVarint(Buffer.from([0xfe, 0x00, 0x00, 0x01, 0x00]), 0)).to.deep.equal({ value: 0x10000, bytes: 5 });
        const nine = Buffer.from([0xff, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00]);
        expect(readVarint(nine, 0)).to.deep.equal({ value: 0x100000001, bytes: 9 });
    });

    it('reads at the given offset', function () {
        expect(readVarint(Buffer.from([0xaa, 0xbb, 0xfd, 0x34, 0x12]), 2)).to.deep.equal({ value: 0x1234, bytes: 3 });
    });

    it('round-trips encodeVarintHex across every width it emits', function () {
        for (const n of [0, 1, 0xfc, 0xfd, 0xffff, 0x10000, 0xffffffff]) {
            const hex = encodeVarintHex(n);
            expect(readVarint(Buffer.from(hex, 'hex'), 0)).to.deep.equal({ value: n, bytes: hex.length / 2 });
        }
    });

    it('throws a RangeError when the buffer ends inside a multi-byte varint', function () {
        expect(() => readVarint(Buffer.from([0xfd, 0x01]), 0)).to.throw(RangeError);
        expect(() => readVarint(Buffer.from([0xfe, 0x01, 0x02]), 0)).to.throw(RangeError);
        expect(() => readVarint(Buffer.from([0xff, 0x01, 0x02, 0x03, 0x04]), 0)).to.throw(RangeError);
    });
});
