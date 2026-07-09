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

// ─── Regression: bulk-sync dump chain-continuity validator ────────────────────
//
// The bulk-sync dump records the node-provided block hash but never recomputes
// it, and nothing checks that consecutive blocks link. orderBatchResults fixed
// the id->height mapping WITHIN a batch RPC; this validator is the defense-in-
// depth complement that catches a Byzantine/buggy node (or on-disk corruption)
// producing valid-looking-but-wrong block bytes. These tests build a real
// header chain and confirm the validator: (a) accepts a good chain, (b) rejects
// a tampered stored hash, (c) rejects a broken prevHash link, (d) rejects a
// non-zero genesis prevHash.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { expect } = require('chai');
const { verifyBlockSequence, validateChainFiles } = require('../../src/bulk-sync/validate-chain');

function sha256(b) { return crypto.createHash('sha256').update(b).digest(); }
function hash256(b) { return sha256(sha256(b)); }
function reverse32(src) {
    const out = Buffer.alloc(32);
    for (let i = 0; i < 32; i++) out[i] = src[31 - i];
    return out;
}

// Build an 80-byte header whose prevHash field is `prevDisplayHash` (display
// order; the field is stored internal-LE, i.e. reversed). The remaining fields
// are arbitrary-but-fixed so the recomputed id is deterministic. Returns
// { blockBytes, blockHash } where blockHash is the display-order id.
function makeBlock(prevDisplayHash, tag) {
    const header = Buffer.alloc(80);
    header.writeUInt32LE(0x20000000, 0);              // version
    reverse32(prevDisplayHash).copy(header, 4);       // prevHash (internal LE)
    crypto.createHash('sha256').update('merkle' + tag).digest().copy(header, 36); // merkleRoot
    header.writeUInt32LE(1700000000 + tag, 68);       // time
    header.writeUInt32LE(0x1d00ffff, 72);             // bits
    header.writeUInt32LE(tag, 76);                    // nonce
    // A block is header + tx data; a couple of trailing bytes stand in for the
    // (unparsed) tx section. The validator only hashes the first 80 bytes.
    const blockBytes = Buffer.concat([header, Buffer.from([0x01, 0x00])]);
    const blockHash = reverse32(hash256(header));
    return { blockBytes, blockHash };
}

// A contiguous chain of `n` blocks starting at `firstHeight`. Block 0's prevHash
// is the given `genesisPrev` (zero for a true genesis).
function makeChain(n, firstHeight, genesisPrev) {
    const blocks = [];
    let prev = genesisPrev;
    for (let i = 0; i < n; i++) {
        const { blockBytes, blockHash } = makeBlock(prev, firstHeight + i);
        blocks.push({ height: firstHeight + i, blockHash, blockBytes });
        prev = blockHash;
    }
    return blocks;
}

describe('Regression: bulk-sync chain-continuity validator', function () {
    it('accepts a valid contiguous chain from genesis', function () {
        const chain = makeChain(4, 0, Buffer.alloc(32, 0));
        const res = verifyBlockSequence(chain);
        expect(res.ok).to.equal(true);
        expect(res.error).to.equal(null);
        expect(res.blocksChecked).to.equal(4);
        expect(res.firstHeight).to.equal(0);
        expect(res.lastHeight).to.equal(3);
    });

    it('accepts a partial chain starting above 0 (no backward link to verify)', function () {
        const chain = makeChain(3, 500000, crypto.randomBytes(32));
        const res = verifyBlockSequence(chain);
        expect(res.ok).to.equal(true);
        expect(res.firstHeight).to.equal(500000);
        expect(res.lastHeight).to.equal(500002);
    });

    it('rejects a tampered stored block hash (node returned wrong bytes for the height)', function () {
        const chain = makeChain(4, 0, Buffer.alloc(32, 0));
        // Flip the stored hash of height 2 as if a batch id mis-map assigned it
        // another block's hash. The header still hashes to its true id.
        chain[2].blockHash = crypto.randomBytes(32);
        const res = verifyBlockSequence(chain);
        expect(res.ok).to.equal(false);
        expect(res.error).to.match(/height 2:.*hash mismatch/);
        expect(res.blocksChecked).to.equal(2); // 0 and 1 passed before the break
    });

    it('rejects a broken prevHash link (orphan block spliced in)', function () {
        const chain = makeChain(4, 0, Buffer.alloc(32, 0));
        // Rebuild height 3 pointing at a wrong parent; its stored hash stays
        // self-consistent so ONLY the link check can catch it.
        const orphan = makeBlock(crypto.randomBytes(32), 999);
        chain[3] = { height: 3, blockHash: orphan.blockHash, blockBytes: orphan.blockBytes };
        const res = verifyBlockSequence(chain);
        expect(res.ok).to.equal(false);
        expect(res.error).to.match(/height 3:.*prevHash link broken/);
    });

    it('rejects a non-zero genesis prevHash', function () {
        const chain = makeChain(2, 0, crypto.randomBytes(32));
        const res = verifyBlockSequence(chain);
        expect(res.ok).to.equal(false);
        expect(res.error).to.match(/height 0:.*genesis prevHash is not zero/);
    });

    it('rejects a block too short to hold an 80-byte header', function () {
        const res = verifyBlockSequence([
            { height: 0, blockHash: Buffer.alloc(32, 0), blockBytes: Buffer.alloc(40) }
        ]);
        expect(res.ok).to.equal(false);
        expect(res.error).to.match(/too short/);
    });

    it('treats an empty dump as trivially ok', function () {
        const res = verifyBlockSequence([]);
        expect(res.ok).to.equal(true);
        expect(res.blocksChecked).to.equal(0);
        expect(res.firstHeight).to.equal(null);
    });
});

// ─── File path: real .xdmp files through XdmpReader + cross-file ordering ──────

const MAGIC = Buffer.from('XCHNDMP1', 'ascii');

// Write a minimal but format-valid .xdmp (matches xdmp-reader.js: 64-byte header,
// then per record block_size(4) + height(4) + blockHash(32) + blockBytes).
function writeXdmp(filePath, blocks) {
    const first = blocks[0].height;
    const last = blocks[blocks.length - 1].height;
    const hdr = Buffer.alloc(64);
    MAGIC.copy(hdr, 0);
    hdr.writeUInt8(1, 8);                    // chain_code: bitcoin
    hdr.writeUInt8(3, 9);                    // net_code: regtest
    hdr.writeUInt16LE(1, 10);                // version
    hdr.writeUInt32LE(first, 12);
    hdr.writeUInt32LE(last, 16);
    hdr.writeUInt32LE(blocks.length, 20);
    hdr.writeUInt32LE(last, 24);             // chainTipAtDump
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

describe('Regression: chain-continuity over real .xdmp files', function () {
    let dir;

    beforeEach(function () {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xdmp-validate-'));
    });

    afterEach(function () {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('validates a chain split across two files given out of filename order', function () {
        const chain = makeChain(6, 0, Buffer.alloc(32, 0));
        // Second file first on disk, and names whose lexical order (9 before 10)
        // would misorder them: proves the validator sorts by dump firstHeight.
        writeXdmp(path.join(dir, 'blocks-bitcoin-regtest-3-5.xdmp'), chain.slice(3, 6));
        writeXdmp(path.join(dir, 'blocks-bitcoin-regtest-0-2.xdmp'), chain.slice(0, 3));
        const files = fs.readdirSync(dir).map(f => path.join(dir, f));
        const res = validateChainFiles(files);
        expect(res.ok).to.equal(true);
        expect(res.blocksChecked).to.equal(6);
        expect(res.firstHeight).to.equal(0);
        expect(res.lastHeight).to.equal(5);
    });

    it('rejects a gap between two dump files', function () {
        const chain = makeChain(6, 0, Buffer.alloc(32, 0));
        writeXdmp(path.join(dir, 'blocks-bitcoin-regtest-0-2.xdmp'), chain.slice(0, 3));
        // Skip height 3: next file starts at 4, leaving a hole.
        writeXdmp(path.join(dir, 'blocks-bitcoin-regtest-4-5.xdmp'), chain.slice(4, 6));
        const files = fs.readdirSync(dir).map(f => path.join(dir, f));
        const res = validateChainFiles(files);
        expect(res.ok).to.equal(false);
        expect(res.error).to.match(/not contiguous/);
    });

    it('catches a hash tamper written into a real .xdmp record', function () {
        const chain = makeChain(3, 0, Buffer.alloc(32, 0));
        chain[1].blockHash = crypto.randomBytes(32); // record disagrees with header
        writeXdmp(path.join(dir, 'blocks-bitcoin-regtest-0-2.xdmp'), chain);
        const res = validateChainFiles([path.join(dir, 'blocks-bitcoin-regtest-0-2.xdmp')]);
        expect(res.ok).to.equal(false);
        expect(res.error).to.match(/height 1:.*hash mismatch/);
    });
});
