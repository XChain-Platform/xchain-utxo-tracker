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

// Key-schema invariant suite: asserts ONCE what several LevelUpDb.js fix
// commits each re-patched piecemeal (rangeEnd 1-byte -> 12-byte -> derived
// 0xFF suffix, key-field length guards, hex/Buffer builder divergence).
//
// Invariants pinned here, over the FULL builder registry:
//  1. Range coverage: for every key any builder can emit, an all-0xFF-suffix
//     key of that length still sorts <= rangeEnd(prefix). A new or widened
//     key type that outgrows rangeEnd's derived suffix fails here in CI
//     instead of silently dropping keys from reorg/restore scans.
//  2. Prefix uniqueness: no two key families share a first byte, so no
//     prefix scan can ever bleed into another family.
//  3. Layout: each builder emits its documented exact length.
//  4. Parity: hex-string and Buffer builder pairs are byte-identical.

const { expect } = require('chai');
const LevelUpStore = require('../../src/LevelUpDb');

const HASH64 = 'a1'.repeat(32);   // 64-hex / 32-byte hash or scriptPubKey
const HASH16 = 'b2'.repeat(8);    // 16-hex / 8-byte txid prefix
const BUF32  = Buffer.from(HASH64, 'hex');
const IDX    = 0xFFFFFFFF;        // max vout, exercises the widest encoding

// The full key-builder registry with max-shape sample keys. Adding a new
// builder to LevelUpDb.js without registering it here is itself a failure
// (the registry-completeness test cross-checks the exports).
const REGISTRY = [
    { name: 'kBlock',     len: 33, key: () => LevelUpStore.kBlock(HASH64) },
    { name: 'kTx',        len: 9,  key: () => LevelUpStore.kTx(HASH16) },
    { name: 'kInput',     len: 13, key: () => LevelUpStore.kInput(HASH16, IDX) },
    { name: 'kOutput',    len: 45, key: () => LevelUpStore.kOutput(HASH64, HASH16, IDX) },
    { name: 'kOutHint',   len: 13, key: () => LevelUpStore.kOutHint(HASH16, IDX) },
    { name: 'kInHint',    len: 21, key: () => LevelUpStore.kInHint(HASH16, HASH16, IDX) },
    { name: 'kScriptBlk', len: 33, key: () => LevelUpStore.kScriptBlk(HASH64) },
    { name: 'kBlkScript', len: 65, key: () => LevelUpStore.kBlkScript(HASH64, HASH64) },
    { name: 'kOutDel',    len: 77, key: () => LevelUpStore.kOutDel(HASH64, HASH64, HASH16, IDX) },
    { name: 'kHintDel',   len: 45, key: () => LevelUpStore.kHintDel(HASH64, HASH16, IDX) },
    { name: 'kStoredBlk', len: 33, key: () => LevelUpStore.kStoredBlk(HASH64) },
    { name: 'kOutBlk',    len: 45, key: () => LevelUpStore.kOutBlk(HASH64, HASH16, IDX) },
];

// Buffer-variant builders mirror a hex builder's bytes, not a new family.
const PARITY_PAIRS = [
    { name: 'kOutput/kOutputFromBuf',
      hex: () => LevelUpStore.kOutput(HASH64, HASH16, IDX),
      buf: () => LevelUpStore.kOutputFromBuf(BUF32, HASH16, IDX) },
    { name: 'kOutDel/kOutDelFromBuf',
      hex: () => LevelUpStore.kOutDel(HASH64, HASH64, HASH16, IDX),
      buf: () => LevelUpStore.kOutDelFromBuf(HASH64, BUF32, HASH16, IDX) },
    { name: 'kScriptBlk/kScriptBlkFromBuf',
      hex: () => LevelUpStore.kScriptBlk(HASH64),
      buf: () => LevelUpStore.kScriptBlkFromBuf(BUF32) },
    { name: 'kBlkScript/kBlkScriptFromBuf',
      hex: () => LevelUpStore.kBlkScript(HASH64, HASH64),
      buf: () => LevelUpStore.kBlkScriptFromBuf(HASH64, BUF32) },
];

describe('LevelUpDb key-schema invariants', function () {

    it('registry is complete: every exported k* builder is registered', function () {
        const exported = Object.keys(LevelUpStore)
            .filter((k) => /^k[A-Z]/.test(k) && !/FromBuf$/.test(k))
            .sort();
        const registered = REGISTRY.map((r) => r.name).sort();
        expect(registered).to.deep.equal(exported);
    });

    REGISTRY.forEach(({ name, len, key }) => {
        it(`${name}: emits its documented exact ${len}-byte layout`, function () {
            expect(key().length).to.equal(len);
        });
    });

    it('prefix bytes are unique across all key families', function () {
        const prefixes = new Map();
        for (const { name, key } of REGISTRY) {
            const p = key()[0];
            expect(prefixes.has(p), `${name} shares prefix 0x${p.toString(16)} with ${prefixes.get(p)}`)
                .to.equal(false);
            prefixes.set(p, name);
        }
    });

    it('rangeEnd covers every key family: an all-0xFF-suffix key of any family\'s length sorts <= rangeEnd(prefix)', function () {
        // This is the invariant behind the twice-fixed dropped-key bug: if a
        // family's keys can exceed the 0xFF suffix bound, a key whose suffix
        // bytes are all 0xFF sorts ABOVE the inclusive lte bound and silently
        // vanishes from prefix scans (unrestored spends on reorg rollback).
        for (const { name, key } of REGISTRY) {
            const sample = key();
            const worst = Buffer.concat([sample.slice(0, 1), Buffer.alloc(sample.length - 1, 0xFF)]);
            const bound = LevelUpStore.rangeEnd(sample.slice(0, 1));
            expect(Buffer.compare(worst, bound), `${name}: worst-case key sorts above rangeEnd`)
                .to.be.at.most(0);
        }
    });

    it('rangeEnd covers short getValuesFromKeyPattern prefixes over the longest (77-byte) key', function () {
        const maxLen = Math.max(...REGISTRY.map((r) => r.key().length));
        for (const prefixLen of [1, 2, 3]) {
            const prefix = Buffer.alloc(prefixLen, 0x4B); // K family, the longest keys
            const worst = Buffer.concat([prefix, Buffer.alloc(maxLen - prefixLen, 0xFF)]);
            const bound = LevelUpStore.rangeEnd(prefix);
            expect(Buffer.compare(worst, bound), `prefix len ${prefixLen} under-covered`)
                .to.be.at.most(0);
        }
    });

    it('rangeEnd never bleeds into the next prefix family', function () {
        for (const { name, key } of REGISTRY) {
            const prefix = key().slice(0, 1);
            const bound = LevelUpStore.rangeEnd(prefix);
            const nextFamily = Buffer.from([prefix[0] + 1]);
            expect(Buffer.compare(bound, nextFamily), `${name}: rangeEnd reaches the next family`)
                .to.be.below(0);
        }
    });

    PARITY_PAIRS.forEach(({ name, hex, buf }) => {
        it(`${name}: hex and Buffer builders are byte-identical`, function () {
            expect(buf().equals(hex()), 'builder pair diverged').to.equal(true);
        });
    });
});
