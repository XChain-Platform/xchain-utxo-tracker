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

// ─── Regression: bulk-sync pipeline hardening (2026-07-10 sweep) ──────────────
//
// Covers the resume/atomicity/determinism fixes:
//   - concatFilesWithHeader: atomic tmp+rename, header uniformity (record_size),
//     cross-file height contiguity, crashed-worker (record_count 0) rejection,
//   - externalSort: deterministic input-order emission for duplicate keys
//     (BIP30 duplicate coinbase class),
//   - RecordReader: rejects a non-record-aligned (truncated) file,
//   - parse-worker existingDatLooksComplete: skip gate validates header count
//     and size instead of bare existence,
//   - dump existingChunkMatchesChain: chunk reuse anchored to the node's chain.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { expect } = require('chai');

const { concatFilesWithHeader } = require('../../src/bulk-sync/orchestrator');
const { externalSort } = require('../../src/bulk-sync/merger/external-sort');
const { RecordReader } = require('../../src/bulk-sync/merger/streaming-join');
const { existingDatLooksComplete } = require('../../src/bulk-sync/parse-worker');
const { existingChunkMatchesChain } = require('../../src/bulk-sync/dump');

const HEADER_SIZE = 64;

// Minimal SPEC-conformant intermediate-file header + fixed records.
function writeDat(filePath, { magic = 'XCHNOUT1', chain = 1, net = 3, firstH, lastH, recordSize, records, countOverride }) {
    const hdr = Buffer.alloc(HEADER_SIZE);
    Buffer.from(magic, 'ascii').copy(hdr, 0);
    hdr.writeUInt8(chain, 8);
    hdr.writeUInt8(net, 9);
    hdr.writeUInt16LE(1, 10);
    hdr.writeUInt32LE(firstH, 12);
    hdr.writeUInt32LE(lastH, 16);
    hdr.writeBigUInt64LE(countOverride !== undefined ? countOverride : BigInt(records.length), 20);
    hdr.writeUInt32LE(recordSize, 28);
    fs.writeFileSync(filePath, Buffer.concat([hdr, ...records]));
}

function rec(size, fill) {
    return Buffer.alloc(size, fill);
}

describe('Regression: bulk-sync pipeline hardening', function () {
    let dir;

    beforeEach(function () {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-hardening-'));
    });

    afterEach(function () {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    describe('concatFilesWithHeader', function () {
        it('concatenates contiguous same-width files and patches the header', function () {
            const a = path.join(dir, 'a.dat'), b = path.join(dir, 'b.dat'), out = path.join(dir, 'out.dat');
            writeDat(a, { firstH: 0, lastH: 4, recordSize: 8, records: [rec(8, 1), rec(8, 2)] });
            writeDat(b, { firstH: 5, lastH: 9, recordSize: 8, records: [rec(8, 3)] });
            concatFilesWithHeader([a, b], out, HEADER_SIZE);
            const buf = fs.readFileSync(out);
            expect(buf.length).to.equal(HEADER_SIZE + 3 * 8);
            expect(buf.readBigUInt64LE(20)).to.equal(3n);       // summed record_count
            expect(buf.readUInt32LE(16)).to.equal(9);           // max lastHeight
            expect(fs.existsSync(out + '.tmp')).to.equal(false); // renamed, no tmp left
        });

        it('rejects mixed record_size inputs (legacy 120B vs coinbase-flagged 121B class)', function () {
            const a = path.join(dir, 'a.dat'), b = path.join(dir, 'b.dat'), out = path.join(dir, 'out.dat');
            writeDat(a, { firstH: 0, lastH: 4, recordSize: 121, records: [rec(121, 1)] });
            writeDat(b, { firstH: 5, lastH: 9, recordSize: 120, records: [rec(120, 2)] });
            expect(() => concatFilesWithHeader([a, b], out, HEADER_SIZE)).to.throw(/recordSize.*differs/);
            expect(fs.existsSync(out)).to.equal(false);         // atomic: no final file on failure
            expect(fs.existsSync(out + '.tmp')).to.equal(false);
        });

        it('rejects a height gap between inputs', function () {
            const a = path.join(dir, 'a.dat'), b = path.join(dir, 'b.dat'), out = path.join(dir, 'out.dat');
            writeDat(a, { firstH: 0, lastH: 4, recordSize: 8, records: [rec(8, 1)] });
            writeDat(b, { firstH: 6, lastH: 9, recordSize: 8, records: [rec(8, 2)] }); // hole at 5
            expect(() => concatFilesWithHeader([a, b], out, HEADER_SIZE)).to.throw(/gap or overlap/);
            expect(fs.existsSync(out)).to.equal(false);
        });

        it('rejects a crashed-worker input (record_count 0 with data present)', function () {
            const a = path.join(dir, 'a.dat'), out = path.join(dir, 'out.dat');
            writeDat(a, { firstH: 0, lastH: 4, recordSize: 8, records: [rec(8, 1)], countOverride: 0n });
            expect(() => concatFilesWithHeader([a], out, HEADER_SIZE)).to.throw(/record_count 0/);
            expect(fs.existsSync(out)).to.equal(false);
        });

        it('accepts a legitimately empty stream (count 0, header-only file)', function () {
            const a = path.join(dir, 'a.dat'), b = path.join(dir, 'b.dat'), out = path.join(dir, 'out.dat');
            writeDat(a, { magic: 'XCHNSPD1', firstH: 0, lastH: 4, recordSize: 20, records: [] });
            writeDat(b, { magic: 'XCHNSPD1', firstH: 5, lastH: 9, recordSize: 20, records: [rec(20, 1)] });
            concatFilesWithHeader([a, b], out, HEADER_SIZE);
            const buf = fs.readFileSync(out);
            expect(buf.readBigUInt64LE(20)).to.equal(1n);
        });
    });

    describe('externalSort duplicate-key determinism', function () {
        it('emits equal keys in input order across multiple runs', async function () {
            // 6 records, 16B each (key = first 8B). Three share one key with a
            // distinguishing payload byte; ramBudget forces 2-record runs so the
            // duplicates land in different runs and only the heap tie-break can
            // keep them in input (chronological) order.
            const RS = 16, KS = 8;
            const dupKey = Buffer.alloc(KS, 0x42);
            const records = [];
            let seq = 0;
            for (const keyFill of [0x42, 0x10, 0x42, 0x99, 0x42, 0x20]) {
                const r = Buffer.alloc(RS);
                (keyFill === 0x42 ? dupKey : Buffer.alloc(KS, keyFill)).copy(r, 0);
                r[RS - 1] = seq++;   // input-order stamp
                records.push(r);
            }
            const input = path.join(dir, 'in.dat');
            fs.writeFileSync(input, Buffer.concat(records));
            const output = path.join(dir, 'sorted.dat');
            await externalSort({
                inputPath: input, outputPath: output,
                recordSize: RS, keySize: KS,
                tmpDir: path.join(dir, 'tmp'),
                ramBudgetBytes: 2 * RS,   // 2 records per run -> 3 runs
            });
            const out = fs.readFileSync(output);
            const dupStamps = [];
            for (let off = 0; off < out.length; off += RS) {
                if (out.subarray(off, off + KS).equals(dupKey)) dupStamps.push(out[off + RS - 1]);
            }
            expect(dupStamps).to.deep.equal([0, 2, 4]); // input order preserved
        });
    });

    describe('RecordReader alignment guard', function () {
        it('throws on a file whose data is not a multiple of recordSize', function () {
            const p = path.join(dir, 'trunc.dat');
            fs.writeFileSync(p, Buffer.alloc(25)); // recordSize 10 -> 2.5 records
            expect(() => new RecordReader(p, 0, 10)).to.throw(/not a multiple of recordSize/);
        });

        it('accepts an aligned file', function () {
            const p = path.join(dir, 'ok.dat');
            fs.writeFileSync(p, Buffer.alloc(30));
            const r = new RecordReader(p, 0, 10);
            expect(r.next()).to.have.length(10);
            r.close();
        });
    });

    describe('parse-worker skip gate (existingDatLooksComplete)', function () {
        it('accepts a complete fixed-record file', function () {
            const p = path.join(dir, 'outputs.dat');
            writeDat(p, { firstH: 0, lastH: 1, recordSize: 8, records: [rec(8, 1), rec(8, 2)] });
            expect(existingDatLooksComplete(p)).to.equal(true);
        });

        it('rejects the record_count-0 crash sentinel (data present)', function () {
            const p = path.join(dir, 'outputs.dat');
            writeDat(p, { firstH: 0, lastH: 1, recordSize: 8, records: [rec(8, 1)], countOverride: 0n });
            expect(existingDatLooksComplete(p)).to.equal(false);
        });

        it('accepts a legitimately empty fixed-record stream (count 0, header only)', function () {
            const p = path.join(dir, 'spends.dat');
            writeDat(p, { magic: 'XCHNSPD1', firstH: 0, lastH: 1, recordSize: 20, records: [] });
            expect(existingDatLooksComplete(p)).to.equal(true);
        });

        it('rejects a count-0 meta stream (every range has blocks)', function () {
            const p = path.join(dir, 'meta.dat');
            writeDat(p, { magic: 'XCHNMTA1', firstH: 0, lastH: 1, recordSize: 0, records: [] });
            expect(existingDatLooksComplete(p)).to.equal(false);
        });

        it('rejects a size/count mismatch (truncated body)', function () {
            const p = path.join(dir, 'outputs.dat');
            writeDat(p, { firstH: 0, lastH: 1, recordSize: 8, records: [rec(8, 1)], countOverride: 5n });
            expect(existingDatLooksComplete(p)).to.equal(false);
        });

        it('checks only the count for variable-length streams (record_size 0)', function () {
            const p = path.join(dir, 'meta.dat');
            writeDat(p, { magic: 'XCHNMTA1', firstH: 0, lastH: 1, recordSize: 0, records: [Buffer.alloc(13, 7)] });
            expect(existingDatLooksComplete(p)).to.equal(true);
        });

        it('returns false for a missing file', function () {
            expect(existingDatLooksComplete(path.join(dir, 'nope.dat'))).to.equal(false);
        });
    });

    describe('dump chunk reuse (existingChunkMatchesChain)', function () {
        const MAGIC = Buffer.from('XCHNDMP1', 'ascii');

        function writeXdmp(filePath, blocks) {
            const hdr = Buffer.alloc(64);
            MAGIC.copy(hdr, 0);
            hdr.writeUInt8(1, 8);
            hdr.writeUInt8(3, 9);
            hdr.writeUInt16LE(1, 10);
            hdr.writeUInt32LE(blocks[0].height, 12);
            hdr.writeUInt32LE(blocks[blocks.length - 1].height, 16);
            hdr.writeUInt32LE(blocks.length, 20);
            const parts = [hdr];
            for (const b of blocks) {
                const prefix = Buffer.alloc(40);
                prefix.writeUInt32LE(b.bytes.length, 0);
                prefix.writeUInt32LE(b.height, 4);
                b.hash.copy(prefix, 8);
                parts.push(prefix, b.bytes);
            }
            fs.writeFileSync(filePath, Buffer.concat(parts));
        }

        function mkBlocks(n) {
            const blocks = [];
            for (let h = 0; h < n; h++) {
                blocks.push({ height: h, hash: crypto.randomBytes(32), bytes: Buffer.alloc(90, h) });
            }
            return blocks;
        }

        it('accepts a chunk whose last hash matches the node', async function () {
            const blocks = mkBlocks(3);
            const p = path.join(dir, 'chunk.xdmp');
            writeXdmp(p, blocks);
            const connector = { getBlockHash: async () => blocks[2].hash.toString('hex') };
            expect(await existingChunkMatchesChain(connector, p, 0, 2)).to.equal(true);
        });

        it('rejects a chunk whose last hash disagrees with the node (reorg)', async function () {
            const blocks = mkBlocks(3);
            const p = path.join(dir, 'chunk.xdmp');
            writeXdmp(p, blocks);
            const connector = { getBlockHash: async () => crypto.randomBytes(32).toString('hex') };
            expect(await existingChunkMatchesChain(connector, p, 0, 2)).to.equal(false);
        });

        it('rejects a chunk covering the wrong range', async function () {
            const blocks = mkBlocks(3);
            const p = path.join(dir, 'chunk.xdmp');
            writeXdmp(p, blocks);
            const connector = { getBlockHash: async () => blocks[2].hash.toString('hex') };
            expect(await existingChunkMatchesChain(connector, p, 0, 5)).to.equal(false);
        });

        it('treats an unreadable file as stale rather than throwing', async function () {
            const p = path.join(dir, 'garbage.xdmp');
            fs.writeFileSync(p, Buffer.alloc(10, 0xEE));
            const connector = { getBlockHash: async () => 'aa'.repeat(32) };
            expect(await existingChunkMatchesChain(connector, p, 0, 2)).to.equal(false);
        });
    });
});
