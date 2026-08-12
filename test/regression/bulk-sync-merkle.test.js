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

// Regression: bulk-sync merkle-root verification (--merkle)
//
// The chain-continuity validator only hashed the 80-byte header, so a node
// substituting the tx list under a genuine header passed silently. The
// --merkle option closes that: every tx is parsed, its txid recomputed, and
// the merkle root rebuilt and compared to the header, with the CVE-2012-2459
// duplicate-pair mutation rejected. These tests build blocks with REAL tx
// bytes (bitcoinjs serialization) so the roots are genuine.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { expect } = require('chai');
const { Transaction } = require('bitcoinjs-lib');
const { verifyBlockSequence, validateChainFiles, computeMerkleRoot } = require('../../src/bulk-sync/validate-chain');

function sha256(b) { return crypto.createHash('sha256').update(b).digest(); }
function hash256(b) { return sha256(sha256(b)); }
function reverse32(src) {
    const out = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) out[i] = src[31 - i];
    return out;
}

// A minimal legacy tx, unique per tag. The first tx of a block should be a
// coinbase (prevout index 0xFFFFFFFF); callers pass coinbase=true for it.
function makeTx(tag, coinbase) {
    const tx = new Transaction();
    tx.version = 2;
    if (coinbase) {
        tx.addInput(Buffer.alloc(32, 0), 0xFFFFFFFF, 0xFFFFFFFF, Buffer.from([0x51, tag & 0xff]));
    } else {
        tx.addInput(sha256('prev' + tag), tag % 3, 0xFFFFFFFF);
    }
    tx.addOutput(Buffer.from([0x6a, 0x01, tag & 0xff]), 1234);
    return tx;
}

// Header + varint tx count + serialized txs, with the header's merkleRoot
// taken from `rootTxids` (defaults to the block's own txids, i.e. a valid
// block). Returns a verifyBlockSequence-shaped record.
function makeBlock(prevDisplayHash, tag, txs, rootTxids) {
    const txids = (rootTxids || txs).map(t => t.getHash(false));
    const { root } = computeMerkleRoot(txids);
    const header = Buffer.alloc(80);
    header.writeUInt32LE(0x20000000, 0);
    reverse32(prevDisplayHash).copy(header, 4);
    root.copy(header, 36);
    header.writeUInt32LE(1700000000 + tag, 68);
    header.writeUInt32LE(0x1d00ffff, 72);
    header.writeUInt32LE(tag, 76);
    if (txs.length >= 0xfd) throw new Error('test helper only writes 1-byte varints');
    const body = Buffer.concat([Buffer.from([txs.length]), ...txs.map(t => t.toBuffer())]);
    return {
        height: tag,
        blockHash: reverse32(hash256(header)),
        blockBytes: Buffer.concat([header, body]),
    };
}

const GENESIS_PREV = Buffer.alloc(32, 0);
const MERKLE_BTC = { merkle: true, coin: 'bitcoin' };

describe('Regression: bulk-sync merkle-root verification', function () {
    it('accepts a valid chain with real tx bodies (even and odd tx counts)', function () {
        const b0 = makeBlock(GENESIS_PREV, 0, [makeTx(0, true), makeTx(1)]);
        const b1 = makeBlock(b0.blockHash, 1, [makeTx(10, true), makeTx(11), makeTx(12)]); // odd: duplication path
        const res = verifyBlockSequence([b0, b1], MERKLE_BTC);
        expect(res.ok).to.equal(true);
        expect(res.error).to.equal(null);
        expect(res.blocksChecked).to.equal(2);
    });

    it('rejects a substituted tx list under a genuine header', function () {
        const real = [makeTx(0, true), makeTx(1)];
        const forged = [makeTx(0, true), makeTx(99)];
        // Header commits to the real txids; body carries the forged list.
        const b0 = makeBlock(GENESIS_PREV, 0, forged, real);
        const res = verifyBlockSequence([b0], MERKLE_BTC);
        expect(res.ok).to.equal(false);
        expect(res.error).to.match(/merkle root mismatch/);
    });

    it('rejects a CVE-2012-2459 duplicate-pair mutation', function () {
        const a = makeTx(0, true), b = makeTx(1), c = makeTx(2);
        // [a,b,c,c] hashes to the same root as [a,b,c] (odd-count duplication),
        // so a mutated body would pass a naive root compare.
        const b0 = makeBlock(GENESIS_PREV, 0, [a, b, c, c], [a, b, c]);
        const res = verifyBlockSequence([b0], MERKLE_BTC);
        expect(res.ok).to.equal(false);
        expect(res.error).to.match(/CVE-2012-2459/);
    });

    it('rejects a block whose tx section is missing', function () {
        const b0 = makeBlock(GENESIS_PREV, 0, [makeTx(0, true)]);
        b0.blockBytes = b0.blockBytes.slice(0, 80);
        const res = verifyBlockSequence([b0], MERKLE_BTC);
        expect(res.ok).to.equal(false);
        expect(res.error).to.match(/no transactions|failed to parse/);
    });

    it('without --merkle a substituted tx list still passes (documented scope limit)', function () {
        const b0 = makeBlock(GENESIS_PREV, 0, [makeTx(0, true), makeTx(99)], [makeTx(0, true), makeTx(1)]);
        const res = verifyBlockSequence([b0]);
        expect(res.ok).to.equal(true);
    });

    it('verifies through the litecoin decoder branch (HogEx-aware path)', function () {
        const b0 = makeBlock(GENESIS_PREV, 0, [makeTx(0, true), makeTx(1)]);
        const res = verifyBlockSequence([b0], { merkle: true, coin: 'litecoin' });
        expect(res.ok).to.equal(true);
    });

    it('computeMerkleRoot: single txid is its own root; genuine duplicate pair flags mutated', function () {
        const h = sha256('only');
        const single = computeMerkleRoot([h]);
        expect(single.root.equals(h)).to.equal(true);
        expect(single.mutated).to.equal(false);
        // Odd trailing self-duplication is legal, not a mutation.
        const odd = computeMerkleRoot([sha256('a'), sha256('b'), sha256('c')]);
        expect(odd.mutated).to.equal(false);
        // A genuine adjacent-equal pair is the CVE-2012-2459 ambiguity.
        const dup = computeMerkleRoot([sha256('a'), sha256('b'), sha256('c'), sha256('c')]);
        expect(dup.mutated).to.equal(true);
        expect(dup.root.equals(odd.root)).to.equal(true); // the two lists collide, which is why it must be rejected
    });

    it('requires opts.coin when merkle is requested', function () {
        expect(() => verifyBlockSequence([], { merkle: true })).to.throw(/opts\.coin/);
    });

    // File path: the coin for the tx decoder is auto-derived from the .xdmp
    // header, so the orchestrator gate needs no extra plumbing.
    describe('validateChainFiles with merkle', function () {
        const MAGIC = Buffer.from('XCHNDMP1', 'ascii');

        // Matches xdmp-reader.js: 64-byte header, then per record
        // block_size(4) + height(4) + blockHash(32) + blockBytes.
        function writeXdmp(filePath, blocks) {
            const hdr = Buffer.alloc(64);
            MAGIC.copy(hdr, 0);
            hdr.writeUInt8(1, 8);                    // chain_code: bitcoin
            hdr.writeUInt8(3, 9);                    // net_code: regtest
            hdr.writeUInt16LE(1, 10);                // version
            hdr.writeUInt32LE(blocks[0].height, 12);
            hdr.writeUInt32LE(blocks[blocks.length - 1].height, 16);
            hdr.writeUInt32LE(blocks.length, 20);
            hdr.writeUInt32LE(blocks[blocks.length - 1].height, 24); // chainTipAtDump
            const parts = [hdr];
            for (const b of blocks) {
                const prefix = Buffer.alloc(40);
                prefix.writeUInt32LE(b.blockBytes.length, 0);
                prefix.writeUInt32LE(b.height, 4);
                b.blockHash.copy(prefix, 8);
                parts.push(prefix, b.blockBytes);
            }
            fs.writeFileSync(filePath, Buffer.concat(parts));
        }

        let dir;
        beforeEach(function () { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdmp-merkle-')); });
        afterEach(function () { fs.rmSync(dir, { recursive: true, force: true }); });

        it('accepts a valid dump and rejects a tampered tx body', function () {
            const b0 = makeBlock(GENESIS_PREV, 0, [makeTx(0, true), makeTx(1)]);
            const b1 = makeBlock(b0.blockHash, 1, [makeTx(10, true)]);
            const file = path.join(dir, 'blocks-bitcoin-regtest-0-1.xdmp');
            writeXdmp(file, [b0, b1]);
            expect(validateChainFiles([file], { merkle: true }).ok).to.equal(true);

            // Flip one byte inside block 1's tx section (past the 80-byte
            // header, so header-only validation would still pass).
            b1.blockBytes[85] ^= 0xff;
            writeXdmp(file, [b0, b1]);
            const res = validateChainFiles([file], { merkle: true });
            expect(res.ok).to.equal(false);
            expect(res.error).to.match(/height 1:.*(merkle root mismatch|failed to parse)/);
            expect(validateChainFiles([file]).ok).to.equal(true); // headers-only misses it
        });
    });
});
