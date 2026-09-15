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

    describe('Buffer-based key builder length guards', () => {
        // The Buffer-based key builders (kOutputFromBuf/kOutDelFromBuf/
        // kScriptBlkFromBuf/kBlkScriptFromBuf) mirror the hex-string builders'
        // layout. Buffer.copy() silently caps at the source length instead of
        // throwing on a short buffer, which can leave uninitialized allocUnsafe
        // garbage in the key. These builders carry the same length assertions
        // their hex counterparts enforce (kOutput/kOutDel).

        it('kOutputFromBuf throws on a short scriptPubKey buffer', () => {
            expect(() => LevelUpStore.kOutputFromBuf(crypto.randomBytes(31), randHash8(), 0))
                .to.throw(/32-byte scriptPubKey buffer/);
        });

        it('kOutputFromBuf throws on a wrong-length txHash8Hex', () => {
            expect(() => LevelUpStore.kOutputFromBuf(randBuf32(), 'ab', 0))
                .to.throw(/16-hex \(8-byte\) txid prefix/);
        });

        it('kOutputFromBuf succeeds with correctly-sized inputs', () => {
            expect(() => LevelUpStore.kOutputFromBuf(randBuf32(), randHash8(), 0)).to.not.throw();
        });

        it('kOutDelFromBuf throws on a short blockHashHex', () => {
            expect(() => LevelUpStore.kOutDelFromBuf('ab', randBuf32(), randHash8(), 0))
                .to.throw(/64-hex \(32-byte\) blockHash/);
        });

        it('kOutDelFromBuf throws on a short scriptPubKey buffer', () => {
            expect(() => LevelUpStore.kOutDelFromBuf(randHash(), crypto.randomBytes(10), randHash8(), 0))
                .to.throw(/32-byte scriptPubKey buffer/);
        });

        it('kOutDelFromBuf throws on a wrong-length txHash8Hex', () => {
            expect(() => LevelUpStore.kOutDelFromBuf(randHash(), randBuf32(), 'ab', 0))
                .to.throw(/16-hex \(8-byte\) txid prefix/);
        });

        it('kOutDelFromBuf succeeds with correctly-sized inputs', () => {
            expect(() => LevelUpStore.kOutDelFromBuf(randHash(), randBuf32(), randHash8(), 0)).to.not.throw();
        });
    });

});

describe('LevelUpDb (extended coverage)', function () {

    describe('Buffer-based key builder length guards', () => {

        it('kScriptBlkFromBuf throws on a short scriptPubKey buffer', () => {
            expect(() => LevelUpStore.kScriptBlkFromBuf(crypto.randomBytes(5)))
                .to.throw(/32-byte scriptPubKey buffer/);
        });

        it('kScriptBlkFromBuf succeeds with a correctly-sized buffer', () => {
            expect(() => LevelUpStore.kScriptBlkFromBuf(randBuf32())).to.not.throw();
        });

        it('kBlkScriptFromBuf throws on a short blockHashHex', () => {
            expect(() => LevelUpStore.kBlkScriptFromBuf('ab', randBuf32()))
                .to.throw(/64-hex \(32-byte\) blockHash/);
        });

        it('kBlkScriptFromBuf throws on a short scriptPubKey buffer', () => {
            expect(() => LevelUpStore.kBlkScriptFromBuf(randHash(), crypto.randomBytes(3)))
                .to.throw(/32-byte scriptPubKey buffer/);
        });

        it('kBlkScriptFromBuf succeeds with correctly-sized inputs', () => {
            expect(() => LevelUpStore.kBlkScriptFromBuf(randHash(), randBuf32())).to.not.throw();
        });
    });

});
