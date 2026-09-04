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

// Boot-time verification that the BigInt-safe bufferutils patch actually took,
// mirroring xchain-decoder's check in XChainDecoder.start(). The patch itself
// (src/applyBufferutilsPatch.js) is applied, never verified: if a shadowed
// bitcoinjs-lib copy or a reordered require leaves it inert, the tracker would
// start normally and then throw mid-parse on the first DOGE output above
// 2^53-1 sat, or decode it differently from correctly patched peers. The guard
// must fire in the CONSTRUCTOR, not in start(): api.js launches with
// tracker.start().catch(...) and does not await it, so a later check would let
// the HTTP surface bind and serve queries first (same reasoning as the
// verifyConsensusPin check it sits beside).
//
// The inactive-patch state is produced by breaking the LIVE reader rather than
// by stubbing the guard, so these cases exercise the shipped probe.

const { expect } = require('chai');
const sinon = require('sinon');
const fs = require('fs');
const path = require('path');

const XChainUtxoTracker = require('../../src/XChainUtxoTracker');
const { bigIntBufferutilsActive, assertBigIntBufferutils } = require('../../src/assertBigIntBufferutils');
const bufferutils = require('bitcoinjs-lib/src/bufferutils');

function makeTracker(networkKey) {
    return new XChainUtxoTracker(networkKey, '127.0.0.1', '8332', 'u', 'p', 'db-bigint-bufferutils-boot', false);
}

// Emulate a stock (unpatched) 64-bit reader: the exact throw the patch exists to
// remove. Restored by sinon.restore() in afterEach.
function breakReader() {
    sinon.stub(bufferutils.BufferReader.prototype, 'readUInt64')
        .throws(new Error('RangeError: value out of range'));
}

describe('utxo-tracker boot BigInt-safe bufferutils verification', function () {
    afterEach(() => sinon.restore());

    it('the probe reports the patch active in a healthy process', function () {
        expect(bigIntBufferutilsActive()).to.equal(true);
    });

    it('the probe reports inactive against a stock-behaving reader', function () {
        breakReader();
        expect(bigIntBufferutilsActive()).to.equal(false);
    });

    it('the probe reads a module with no BufferReader as inactive', function () {
        expect(bigIntBufferutilsActive({})).to.equal(false);
    });

    it('constructing a dogecoin tracker halts fail-closed when the patch is inert', function () {
        breakReader();
        expect(() => makeTracker('dogecoin-mainnet')).to.throw(/BigInt-safe 64-bit reader is NOT active/);
    });

    it('constructs a dogecoin tracker normally while the patch holds', function () {
        expect(() => makeTracker('dogecoin-mainnet')).to.not.throw();
    });

    it('leaves non-dogecoin coins alone even with the reader broken', function () {
        breakReader();
        expect(() => makeTracker('bitcoin-mainnet')).to.not.throw();
        expect(() => makeTracker('litecoin-mainnet')).to.not.throw();
        expect(() => assertBigIntBufferutils('litecoin', 'unit')).to.not.throw();
    });

    it('names the failing entry point in the message', function () {
        expect(() => assertBigIntBufferutils('dogecoin', 'bulk-sync parse-worker', {}))
            .to.throw(/Dogecoin bulk-sync parse-worker/);
    });

    it('runs the check after the decoder that applies the patch, not before', function () {
        // Ordering matters: the probe reads the live bufferutils module, which only
        // reflects the patch once XChainBlockDecoder has required it.
        const src = fs.readFileSync(
            path.join(__dirname, '..', '..', 'src', 'XChainUtxoTracker.js'), 'utf8');
        const decoderAt = src.indexOf('this.xchainBlockDecoder = new XChainBlockDecoder(network)');
        const assertAt = src.indexOf('assertBigIntBufferutils(');
        expect(decoderAt).to.be.greaterThan(-1);
        expect(assertAt).to.be.greaterThan(-1);
        expect(decoderAt).to.be.lessThan(assertAt);
    });

    it('covers the two bulk-sync entry points the constructor cannot reach', function () {
        // Both are separate processes that build a decoder without a tracker, so the
        // constructor check above never runs for them.
        for (const rel of [['bulk-sync', 'parse-worker.js'], ['bulk-sync', 'validate-chain.js']]) {
            const file = path.join(__dirname, '..', '..', 'src', ...rel);
            const src = fs.readFileSync(file, 'utf8');
            const decoderAt = src.indexOf('new XChainBlockDecoder(');
            const assertAt = src.indexOf('assertBigIntBufferutils(');
            expect(decoderAt, rel.join('/') + ' constructs a decoder').to.be.greaterThan(-1);
            expect(assertAt, rel.join('/') + ' is missing the bufferutils guard').to.be.greaterThan(-1);
            expect(decoderAt).to.be.lessThan(assertAt);
        }
    });
});
