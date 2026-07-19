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
const LevelUpStore = require('../../src/LevelUpDb');
const { encodeBlock, encodeTx, encodeInputVal, encodeOutHint, encodeOutput } = LevelUpStore;

const HEX64 = 'a'.repeat(64);
const HEX16 = 'b'.repeat(16);
const ZERO_HASH = '0'.repeat(64);

describe('LevelUpDb value-encoder width guards', function () {

    describe('encodeBlock (previousHash)', function () {
        it('accepts a correct 64-hex previousHash', function () {
            expect(encodeBlock(1, 2, HEX64)).to.have.length(40);
        });
        it('throws with the function name on a wrong-width previousHash', function () {
            expect(() => encodeBlock(1, 2, 'abc')).to.throw(/encodeBlock expects a 64-hex/);
        });
    });

    describe('encodeTx (blockHash)', function () {
        it('accepts a correct 64-hex blockHash', function () {
            expect(encodeTx(HEX64)).to.have.length(32);
        });
        it('no-arg path still returns the 32-byte ZERO_HASH buffer', function () {
            const buf = encodeTx();
            expect(buf).to.have.length(32);
            expect(buf.toString('hex')).to.equal(ZERO_HASH);
        });
        it('throws with the function name on a wrong-width blockHash', function () {
            expect(() => encodeTx('dead')).to.throw(/encodeTx expects a 64-hex/);
        });
    });

    describe('encodeInputVal (txHash8)', function () {
        it('accepts a correct 16-hex txid prefix', function () {
            expect(encodeInputVal(HEX16)).to.have.length(8);
        });
        it('throws with the function name on a wrong-width txid prefix', function () {
            expect(() => encodeInputVal('bb')).to.throw(/encodeInputVal expects a 16-hex/);
        });
    });

    describe('encodeOutHint (scriptHex)', function () {
        it('accepts a correct 64-hex scriptPubKey', function () {
            expect(encodeOutHint(HEX64)).to.have.length(32);
        });
        it('throws with the function name on a wrong-width scriptPubKey', function () {
            expect(() => encodeOutHint('ff')).to.throw(/encodeOutHint expects a 64-hex/);
        });
    });

    describe('encodeOutput (optional fullTxHash)', function () {
        it('accepts a correct 64-hex fullTxHash', function () {
            expect(encodeOutput(100, 5, HEX64)).to.have.length(44);
        });
        it('falsy fullTxHash still works without throwing (zero-hash sentinel)', function () {
            const buf = encodeOutput(100, 5, null);
            expect(buf).to.have.length(44);
            expect(buf.slice(12, 44).toString('hex')).to.equal(ZERO_HASH);
        });
        it('throws with the function name on a truthy wrong-width fullTxHash', function () {
            expect(() => encodeOutput(100, 5, 'abcd')).to.throw(/encodeOutput expects a 64-hex/);
        });
    });
});
