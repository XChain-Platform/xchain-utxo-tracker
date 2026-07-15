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

//  regression: the BigInt-safe bufferutils patch must be active
// in-process (not only via the Dockerfile COPY over node_modules), or a
// Dogecoin output > 2^53-1 sat (~90.07M DOGE) throws during block decode and
// wedges the tracker permanently on any non-Docker run.

const { expect } = require('chai');
const bufferutils = require('../../src/applyBufferutilsPatch');
const transaction_js_1 = require('bitcoinjs-lib/src/transaction');

// Minimal legacy tx: 1 coinbase-style input, 1 output carrying 2^53 sat
// (one past the stock reader's ceiling) with an empty scriptPubKey.
const LARGE_OUTPUT_TX_HEX =
    '01000000' +                                                          // version
    '01' +                                                                // vin count
    '0000000000000000000000000000000000000000000000000000000000000000' +  // prevout hash
    'ffffffff' +                                                          // prevout index
    '00' +                                                                // scriptSig len
    'ffffffff' +                                                          // sequence
    '01' +                                                                // vout count
    '0000000000002000' +                                                  // value: 2^53 LE
    '00' +                                                                // scriptPubKey len
    '00000000';                                                           // locktime

describe('applyBufferutilsPatch ', function () {

    it('patches the shared bitcoinjs-lib bufferutils module in place', function () {
        expect(bufferutils).to.equal(require('bitcoinjs-lib/src/bufferutils'));
    });

    it('BufferReader.readUInt64 returns values above 2^53-1 as unsigned BigInt', function () {
        const at2pow53 = new bufferutils.BufferReader(Buffer.from('0000000000002000', 'hex'));
        expect(at2pow53.readUInt64()).to.equal(9007199254740992n);

        // High bit set: the signed reader would return a negative BigInt.
        const highBit = new bufferutils.BufferReader(Buffer.from('0000000000000080', 'hex'));
        expect(highBit.readUInt64()).to.equal(9223372036854775808n);

        const max = new bufferutils.BufferReader(Buffer.from('ffffffffffffffff', 'hex'));
        expect(max.readUInt64()).to.equal(18446744073709551615n);
    });

    it('BufferWriter.writeUInt64 round-trips a BigInt value', function () {
        const writer = new bufferutils.BufferWriter(Buffer.alloc(8));
        writer.writeUInt64(9007199254740993n);
        expect(new bufferutils.BufferReader(writer.end()).readUInt64()).to.equal(9007199254740993n);
    });

    it('exported readUInt64LE/writeUInt64LE keep the Number-safe contract', function () {
        const buf = Buffer.alloc(8);
        expect(bufferutils.writeUInt64LE(buf, Number.MAX_SAFE_INTEGER, 0)).to.equal(8);
        expect(bufferutils.readUInt64LE(buf, 0)).to.equal(Number.MAX_SAFE_INTEGER);
        expect(() => bufferutils.readUInt64LE(Buffer.from('0000000000002000', 'hex'), 0))
            .to.throw(/value out of range/);
    });

    it('decodes a transaction whose output value exceeds 2^53-1 sat', function () {
        const tx = transaction_js_1.Transaction.fromBuffer(Buffer.from(LARGE_OUTPUT_TX_HEX, 'hex'));
        expect(BigInt(tx.outs[0].value)).to.equal(9007199254740992n);
    });
});
