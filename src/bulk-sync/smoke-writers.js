'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Ad-hoc smoke test for writers.js. Not a mocha test; uses plain assertions.
// Writes a few synthetic records with each writer, reads the file back,
// verifies header bytes and record layout match SPEC.md.

const fs   = require('fs')
const os   = require('os')
const path = require('path')
const assert = require('assert')

const {
    OutputsWriter, SpendsWriter, MetaWriter,
    HEADER_SIZE, OUTPUTS_RECORD_SIZE, SPENDS_RECORD_SIZE,
    MAGIC_OUTPUTS, MAGIC_SPENDS, MAGIC_META,
} = require('./writers.js')

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-bulk-sync-smoke-'))
console.log('[smoke] tmp dir:', TMP_DIR)

function readHeader(file) {
    const fd  = fs.openSync(file, 'r')
    const buf = Buffer.alloc(HEADER_SIZE)
    fs.readSync(fd, buf, 0, HEADER_SIZE, 0)
    fs.closeSync(fd)
    return {
        magic:       buf.slice(0, 8),
        chain:       buf.readUInt8(8),
        net:         buf.readUInt8(9),
        version:     buf.readUInt16LE(10),
        firstHeight: buf.readUInt32LE(12),
        lastHeight:  buf.readUInt32LE(16),
        recordCount: Number(buf.readBigUInt64LE(20)),
        recordSize:  buf.readUInt32LE(28),
    }
}

function hex(b) { return Buffer.from(b).toString('hex') }

// OutputsWriter
{
    const file = path.join(TMP_DIR, 'outputs-w00-h00000000-h00000099.dat')
    const w = new OutputsWriter(file, 'bitcoin', 'regtest', 0, 99)

    const txHash8  = Buffer.from('0123456789abcdef', 'hex')
    const fullTx   = Buffer.from('0123456789abcdef' + '0'.repeat(48), 'hex')
    const script   = Buffer.alloc(32, 0xaa)
    const blockH   = Buffer.alloc(32, 0xbb)

    w.append(txHash8, 0, 5000000000, 1, fullTx, script, blockH)
    w.append(txHash8, 1, 42n,        2, fullTx, script, blockH)
    w.close()

    assert.strictEqual(fs.existsSync(file + '.tmp'), false, 'tmp still present')
    const h = readHeader(file)
    assert.strictEqual(hex(h.magic), hex(MAGIC_OUTPUTS), 'outputs magic')
    assert.strictEqual(h.chain,       1)
    assert.strictEqual(h.net,         3)
    assert.strictEqual(h.version,     1)
    assert.strictEqual(h.firstHeight, 0)
    assert.strictEqual(h.lastHeight,  99)
    assert.strictEqual(h.recordCount, 2)
    assert.strictEqual(h.recordSize,  OUTPUTS_RECORD_SIZE)

    const stat = fs.statSync(file)
    assert.strictEqual(stat.size, HEADER_SIZE + 2 * OUTPUTS_RECORD_SIZE)

    const buf = fs.readFileSync(file)
    // Record 0
    const r0 = buf.slice(HEADER_SIZE, HEADER_SIZE + OUTPUTS_RECORD_SIZE)
    assert.strictEqual(hex(r0.slice(0, 8)),    '0123456789abcdef')
    assert.strictEqual(r0.readUInt32BE(8),     0)
    assert.strictEqual(r0.readBigUInt64BE(12), 5000000000n)
    assert.strictEqual(r0.readInt32BE(20),     1)
    assert.strictEqual(hex(r0.slice(24, 56)),  hex(fullTx))
    assert.strictEqual(hex(r0.slice(56, 88)),  hex(script))
    assert.strictEqual(hex(r0.slice(88, 120)), hex(blockH))
    // Record 1
    const r1 = buf.slice(HEADER_SIZE + OUTPUTS_RECORD_SIZE, HEADER_SIZE + 2 * OUTPUTS_RECORD_SIZE)
    assert.strictEqual(r1.readUInt32BE(8),     1)
    assert.strictEqual(r1.readBigUInt64BE(12), 42n)
    assert.strictEqual(r1.readInt32BE(20),     2)

    console.log('[smoke] OutputsWriter OK')
}

// SpendsWriter
{
    const file = path.join(TMP_DIR, 'spends-w00-h00000000-h00000099.dat')
    const w = new SpendsWriter(file, 'bitcoin', 'regtest', 0, 99)

    const prev8    = Buffer.from('aabbccddeeff0011', 'hex')
    const spender8 = Buffer.from('2233445566778899', 'hex')
    w.append(prev8, 7, spender8)
    w.close()

    const h = readHeader(file)
    assert.strictEqual(hex(h.magic), hex(MAGIC_SPENDS))
    assert.strictEqual(h.recordCount, 1)
    assert.strictEqual(h.recordSize,  SPENDS_RECORD_SIZE)

    const buf = fs.readFileSync(file)
    assert.strictEqual(buf.length, HEADER_SIZE + SPENDS_RECORD_SIZE)
    const r = buf.slice(HEADER_SIZE)
    assert.strictEqual(hex(r.slice(0, 8)),   'aabbccddeeff0011')
    assert.strictEqual(r.readUInt32BE(8),    7)
    assert.strictEqual(hex(r.slice(12, 20)), '2233445566778899')

    console.log('[smoke] SpendsWriter OK')
}

// MetaWriter
{
    const file = path.join(TMP_DIR, 'meta-w00-h00000000-h00000099.dat')
    const w = new MetaWriter(file, 'bitcoin', 'regtest', 0, 99)

    const blockA = Buffer.alloc(32, 0x11)
    const prevA  = Buffer.alloc(32, 0x10)
    const tx1    = Buffer.from('1111111111111111', 'hex')
    const tx2    = Buffer.from('2222222222222222', 'hex')
    w.writeBlock(0, 1700000000, blockA, prevA, [tx1, tx2])

    const blockB = Buffer.alloc(32, 0x22)
    const prevB  = blockA
    const tx3    = Buffer.from('3333333333333333', 'hex')
    w.writeBlock(1, 1700000600, blockB, prevB, [tx3])

    w.close()

    const h = readHeader(file)
    assert.strictEqual(hex(h.magic), hex(MAGIC_META))
    assert.strictEqual(h.recordCount, 2, 'meta counts blocks, not txs')
    assert.strictEqual(h.recordSize,  0, 'meta is variable length')

    const buf = fs.readFileSync(file)
    const expectedSize = HEADER_SIZE + (76 + 2 * 8) + (76 + 1 * 8)
    assert.strictEqual(buf.length, expectedSize)

    // Block A
    let off = HEADER_SIZE
    assert.strictEqual(buf.readUInt32BE(off + 0),  0)
    assert.strictEqual(buf.readUInt32BE(off + 4),  1700000000)
    assert.strictEqual(hex(buf.slice(off + 8,  off + 40)), hex(blockA))
    assert.strictEqual(hex(buf.slice(off + 40, off + 72)), hex(prevA))
    assert.strictEqual(buf.readUInt32BE(off + 72), 2)
    assert.strictEqual(hex(buf.slice(off + 76, off + 84)), '1111111111111111')
    assert.strictEqual(hex(buf.slice(off + 84, off + 92)), '2222222222222222')

    // Block B
    off += 76 + 16
    assert.strictEqual(buf.readUInt32BE(off + 0),  1)
    assert.strictEqual(buf.readUInt32BE(off + 4),  1700000600)
    assert.strictEqual(hex(buf.slice(off + 8,  off + 40)), hex(blockB))
    assert.strictEqual(buf.readUInt32BE(off + 72), 1)
    assert.strictEqual(hex(buf.slice(off + 76, off + 84)), '3333333333333333')

    console.log('[smoke] MetaWriter OK')
}

// abort() leaves no rogue final file
{
    const file = path.join(TMP_DIR, 'outputs-abort-test.dat')
    const w = new OutputsWriter(file, 'bitcoin', 'regtest', 0, 0)
    w.abort()
    assert.strictEqual(fs.existsSync(file), false, 'abort must not produce final file')
    console.log('[smoke] abort() OK')
}

// Cleanup
fs.rmSync(TMP_DIR, { recursive: true, force: true })
console.log('[smoke] all checks passed')
