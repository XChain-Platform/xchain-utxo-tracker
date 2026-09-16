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

    describe('Hex-string key builder length guards (uuid:d59a4d11)', () => {
        // kBlock/kTx/kScriptBlk/kBlkScript require length guards because
        // allocUnsafe with a short or odd-length hash leaves uninitialized memory
        // in the key (buf.write stops at the first invalid nibble). The guards match
        // their siblings so malformed hex fails loud instead of producing a
        // nondeterministic key.
        it('kBlock throws on a wrong-length blockHash', () => {
            expect(() => LevelUpStore.kBlock('abcd')).to.throw(/64-hex \(32-byte\) blockHash/);
        });
        it('kBlock succeeds with a 64-hex blockHash', () => {
            expect(() => LevelUpStore.kBlock(randHash())).to.not.throw();
        });
        it('kTx throws on a wrong-length txid prefix', () => {
            expect(() => LevelUpStore.kTx(randHash())).to.throw(/16-hex \(8-byte\) txid prefix/);
        });
        it('kTx succeeds with a 16-hex prefix', () => {
            expect(() => LevelUpStore.kTx(randHash8())).to.not.throw();
        });
        it('kScriptBlk throws on a wrong-length scriptPubKey', () => {
            expect(() => LevelUpStore.kScriptBlk('ab')).to.throw(/64-hex \(32-byte\) scriptPubKey/);
        });
        it('kScriptBlk succeeds with a 64-hex scriptPubKey', () => {
            expect(() => LevelUpStore.kScriptBlk(randHash())).to.not.throw();
        });
        it('kBlkScript throws on a wrong-length blockHash', () => {
            expect(() => LevelUpStore.kBlkScript('ab', randHash())).to.throw(/64-hex \(32-byte\) blockHash/);
        });
        it('kBlkScript throws on a wrong-length scriptPubKey', () => {
            expect(() => LevelUpStore.kBlkScript(randHash(), 'ab')).to.throw(/64-hex \(32-byte\) scriptPubKey/);
        });
        it('kBlkScript succeeds with two 64-hex inputs', () => {
            expect(() => LevelUpStore.kBlkScript(randHash(), randHash())).to.not.throw();
        });
    });

});
