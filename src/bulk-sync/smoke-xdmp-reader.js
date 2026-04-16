'use strict'

// Ad-hoc smoke test for xdmp-reader.js. Builds synthetic .xdmp files that
// match dump.js's byte layout, then reads them back with XdmpReader and
// asserts height/blockHash/blockBytes match byte-for-byte. Also covers
// error paths: bad magic, height gap, short prefix read.

const fs     = require('fs')
const os     = require('os')
const path   = require('path')
const assert = require('assert')

const { XdmpReader, HEADER_SIZE } = require('./xdmp-reader.js')

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-xdmp-reader-'))
console.log('[smoke/xdmp-reader] tmp dir:', TMP_DIR)

// ---- helpers to build a synthetic .xdmp in memory ----

function buildHeader({ chain=1, net=3, version=1, firstHeight, lastHeight, chainTip }) {
    const buf = Buffer.alloc(HEADER_SIZE)
    Buffer.from('XCHNDMP1', 'ascii').copy(buf, 0)
    buf.writeUInt8(chain, 8)
    buf.writeUInt8(net,   9)
    buf.writeUInt16LE(version, 10)
    buf.writeUInt32LE(firstHeight, 12)
    buf.writeUInt32LE(lastHeight,  16)
    buf.writeUInt32LE(lastHeight - firstHeight + 1, 20)
    buf.writeUInt32LE(chainTip != null ? chainTip : lastHeight, 24)
    return buf
}

function buildRecord(height, blockHash, blockBytes) {
    const prefix = Buffer.alloc(40)
    prefix.writeUInt32LE(blockBytes.length, 0)
    prefix.writeUInt32LE(height,            4)
    blockHash.copy(prefix, 8)
    return Buffer.concat([prefix, blockBytes])
}

function writeXdmp(filePath, header, records) {
    fs.writeFileSync(filePath, Buffer.concat([header, ...records]))
}

// ---- case 1: 3 blocks, varying sizes, all readable ----
{
    const firstHeight = 100
    const lastHeight  = 102
    const header      = buildHeader({ firstHeight, lastHeight, chainTip: 200 })

    const hash0 = Buffer.alloc(32, 0x01)
    const hash1 = Buffer.alloc(32, 0x02)
    const hash2 = Buffer.alloc(32, 0x03)

    const blk0 = Buffer.alloc(80,   0xaa) // header-only mini-block
    const blk1 = Buffer.alloc(512,  0xbb)
    const blk2 = Buffer.alloc(4097, 0xcc) // odd size, crosses 4KB

    const file = path.join(TMP_DIR, 'happy.xdmp')
    writeXdmp(file, header, [
        buildRecord(100, hash0, blk0),
        buildRecord(101, hash1, blk1),
        buildRecord(102, hash2, blk2),
    ])

    const reader = new XdmpReader(file)
    assert.strictEqual(reader.chain,       'bitcoin')
    assert.strictEqual(reader.network,     'regtest')
    assert.strictEqual(reader.firstHeight, 100)
    assert.strictEqual(reader.lastHeight,  102)
    assert.strictEqual(reader.blockCount,  3)
    assert.strictEqual(reader.chainTipAtDump, 200)

    const collected = []
    for (const item of reader.blocks()) {
        // Copy blockBytes since it's a view that will be invalidated next iteration.
        collected.push({
            height:     item.height,
            blockHash:  item.blockHash,
            blockBytes: Buffer.from(item.blockBytes),
        })
    }
    reader.close()

    assert.strictEqual(collected.length, 3)
    assert.strictEqual(collected[0].height, 100)
    assert.strictEqual(collected[0].blockHash.toString('hex'), hash0.toString('hex'))
    assert.strictEqual(collected[0].blockBytes.toString('hex'), blk0.toString('hex'))
    assert.strictEqual(collected[1].blockBytes.toString('hex'), blk1.toString('hex'))
    assert.strictEqual(collected[2].blockBytes.toString('hex'), blk2.toString('hex'))
    assert.strictEqual(collected[2].blockHash.toString('hex'), hash2.toString('hex'))

    console.log('[smoke/xdmp-reader] happy path OK')
}

// ---- case 2: blockBytes view semantics — confirm the caller MUST copy ----
{
    const header = buildHeader({ firstHeight: 0, lastHeight: 1, chainTip: 1 })
    const file = path.join(TMP_DIR, 'view.xdmp')
    writeXdmp(file, header, [
        buildRecord(0, Buffer.alloc(32, 0xaa), Buffer.alloc(64, 0x11)),
        buildRecord(1, Buffer.alloc(32, 0xbb), Buffer.alloc(64, 0x22)),
    ])

    const reader = new XdmpReader(file)
    const it = reader.blocks()

    const first  = it.next().value
    const firstBytesRef = first.blockBytes // view into scratch
    assert.strictEqual(firstBytesRef[0], 0x11)

    // Advance: scratch gets overwritten.
    const second = it.next().value
    assert.strictEqual(second.blockBytes[0], 0x22)
    // firstBytesRef is now aliasing the SAME scratch region — it sees 0x22.
    assert.strictEqual(firstBytesRef[0], 0x22,
        'confirming view is invalidated on next iteration (caller must copy)')

    assert.strictEqual(it.next().done, true)
    reader.close()

    console.log('[smoke/xdmp-reader] view invalidation behaves as documented')
}

// ---- case 3: scratch grows when a block exceeds initial 4 MB ----
{
    // Use a bigger-than-initial block size but small enough to keep the test fast.
    const bigSize = 4 * 1024 * 1024 + 100
    const header = buildHeader({ firstHeight: 0, lastHeight: 0, chainTip: 0 })
    const hash   = Buffer.alloc(32, 0x09)
    const blk    = Buffer.alloc(bigSize, 0x77)
    blk[0]       = 0xaa
    blk[bigSize - 1] = 0xbb

    const file = path.join(TMP_DIR, 'big.xdmp')
    writeXdmp(file, header, [ buildRecord(0, hash, blk) ])

    const reader = new XdmpReader(file)
    const { blockBytes } = reader.blocks().next().value
    assert.strictEqual(blockBytes.length, bigSize)
    assert.strictEqual(blockBytes[0], 0xaa)
    assert.strictEqual(blockBytes[bigSize - 1], 0xbb)
    reader.close()

    console.log('[smoke/xdmp-reader] scratch grows for large blocks')
}

// ---- case 4: bad magic ----
{
    const header = buildHeader({ firstHeight: 0, lastHeight: 0 })
    Buffer.from('XNOPE___', 'ascii').copy(header, 0)
    const file = path.join(TMP_DIR, 'bad-magic.xdmp')
    fs.writeFileSync(file, header)

    let caught
    try { new XdmpReader(file) } catch (e) { caught = e }
    assert.ok(caught, 'bad magic should throw')
    assert.match(caught.message, /bad magic/)
    console.log('[smoke/xdmp-reader] bad magic rejected')
}

// ---- case 5: height gap ----
{
    const header = buildHeader({ firstHeight: 10, lastHeight: 12, chainTip: 12 })
    const file = path.join(TMP_DIR, 'gap.xdmp')
    const blk = Buffer.alloc(64, 0x00)
    writeXdmp(file, header, [
        buildRecord(10, Buffer.alloc(32, 1), blk),
        buildRecord(12, Buffer.alloc(32, 2), blk), // skips 11
        buildRecord(13, Buffer.alloc(32, 3), blk),
    ])
    // header says block_count = 3 so blockCount validation passes; gap shows
    // up when we read the 2nd record and expected_height is 11.
    const reader = new XdmpReader(file)
    let caught
    try {
        for (const _ of reader.blocks()) { /* consume */ }
    } catch (e) { caught = e }
    assert.ok(caught, 'height gap should throw')
    assert.match(caught.message, /height gap/)
    reader.close()
    console.log('[smoke/xdmp-reader] height gap rejected')
}

// ---- case 6: block_count header mismatch ----
{
    const header = buildHeader({ firstHeight: 0, lastHeight: 2, chainTip: 2 })
    header.writeUInt32LE(99, 20) // lie about block_count
    const file = path.join(TMP_DIR, 'count-lie.xdmp')
    fs.writeFileSync(file, header)

    let caught
    try { new XdmpReader(file) } catch (e) { caught = e }
    assert.ok(caught, 'block_count mismatch should throw')
    assert.match(caught.message, /block_count mismatch/)
    console.log('[smoke/xdmp-reader] block_count mismatch rejected')
}

// ---- case 7: short prefix (file truncated mid-stream) ----
{
    const header = buildHeader({ firstHeight: 0, lastHeight: 1, chainTip: 1 })
    const blk    = Buffer.alloc(64, 0x55)
    const rec    = buildRecord(0, Buffer.alloc(32, 0x01), blk)
    // Write header + first full record + just 10 bytes of the 2nd prefix.
    const truncatedSecond = buildRecord(1, Buffer.alloc(32, 0x02), blk).slice(0, 10)
    const file = path.join(TMP_DIR, 'truncated.xdmp')
    fs.writeFileSync(file, Buffer.concat([header, rec, truncatedSecond]))

    const reader = new XdmpReader(file)
    let caught
    try {
        for (const _ of reader.blocks()) { /* consume */ }
    } catch (e) { caught = e }
    assert.ok(caught, 'truncated file should throw')
    assert.match(caught.message, /short prefix|short data/)
    reader.close()
    console.log('[smoke/xdmp-reader] truncated file rejected')
}

fs.rmSync(TMP_DIR, { recursive: true, force: true })
console.log('[smoke/xdmp-reader] all checks passed')
