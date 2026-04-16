'use strict'

/*********************************************************************
 *
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 *
 **********************************************************************
 *
 * XChain UTXO Tracker - Bulk Sync .xdmp Reader
 *
 * Streaming reader for .xdmp files produced by dump.js. Validates the
 * header, then yields { height, blockHash, blockBytes } for each block
 * record in the file, in the original dump order (ascending height, no
 * gaps).
 *
 * The yielded `blockHash` is a fresh 32-byte copy (safe to retain).
 * The yielded `blockBytes` is a SLICE into an internal scratch buffer
 * and is INVALIDATED on the next iteration — the caller must consume
 * it (typically via decoder.blockFromBuffer(...)) before advancing the
 * generator. This avoids per-block allocations over 32 MB on mainnet.
 *
 ********************************************************************/

const fs = require('fs')

const HEADER_SIZE      = 64
const RECORD_PREFIX    = 40      // block_size(4) + height(4) + blockHash(32)
const MAX_BLOCK_SIZE   = 32 * 1024 * 1024
const INITIAL_DATA_BUF = 4 * 1024 * 1024

const MAGIC_DUMP       = Buffer.from('XCHNDMP1', 'ascii')
const FILE_VERSION     = 1

const CHAIN_NAMES      = { 1: 'bitcoin', 2: 'litecoin', 3: 'dogecoin' }
const NETWORK_NAMES    = { 1: 'mainnet', 2: 'testnet', 3: 'regtest' }

class XdmpReader {
    constructor(filePath) {
        this._filePath     = filePath
        this._fd           = fs.openSync(filePath, 'r')
        this._pos          = 0
        this._closed       = false
        this._prefixBuf    = Buffer.alloc(RECORD_PREFIX)
        this._dataBuf      = Buffer.alloc(INITIAL_DATA_BUF)

        const hdr = Buffer.alloc(HEADER_SIZE)
        const n   = fs.readSync(this._fd, hdr, 0, HEADER_SIZE, 0)
        if (n !== HEADER_SIZE) {
            this._fail(`short header read: ${n}/${HEADER_SIZE} bytes`)
        }
        this._pos = HEADER_SIZE

        if (hdr.slice(0, 8).compare(MAGIC_DUMP) !== 0) {
            this._fail(`bad magic: expected XCHNDMP1, got ${hdr.slice(0, 8).toString('ascii')}`)
        }

        const chainCode = hdr.readUInt8(8)
        const netCode   = hdr.readUInt8(9)
        const version   = hdr.readUInt16LE(10)
        if (!(chainCode in CHAIN_NAMES))   this._fail(`unknown chain_code ${chainCode}`)
        if (!(netCode   in NETWORK_NAMES)) this._fail(`unknown net_code ${netCode}`)
        if (version !== FILE_VERSION)      this._fail(`unsupported version ${version}`)

        this.chain          = CHAIN_NAMES[chainCode]
        this.network        = NETWORK_NAMES[netCode]
        this.version        = version
        this.firstHeight    = hdr.readUInt32LE(12)
        this.lastHeight     = hdr.readUInt32LE(16)
        this.blockCount     = hdr.readUInt32LE(20)
        this.chainTipAtDump = hdr.readUInt32LE(24)

        const expectedCount = this.lastHeight - this.firstHeight + 1
        if (this.blockCount !== expectedCount) {
            this._fail(`block_count mismatch: header says ${this.blockCount}, heights imply ${expectedCount}`)
        }
    }

    _fail(msg) {
        this.close()
        throw new Error(`[xdmp-reader] ${this._filePath}: ${msg}`)
    }

    /**
     * Generator yielding each block in dump order.
     *
     * @yields {{ height: number, blockHash: Buffer, blockBytes: Buffer }}
     *   - blockHash is a fresh 32-byte copy (safe to retain)
     *   - blockBytes is a view into the reader's internal scratch buffer;
     *     it is invalidated on the next next() call, so the caller must
     *     consume it before advancing the generator
     */
    *blocks() {
        if (this._closed) throw new Error('[xdmp-reader] blocks() called on closed reader')

        let prevHeight = this.firstHeight - 1
        let blocksRead = 0

        while (blocksRead < this.blockCount) {
            const prefixRead = fs.readSync(this._fd, this._prefixBuf, 0, RECORD_PREFIX, this._pos)
            if (prefixRead !== RECORD_PREFIX) {
                this._fail(`short prefix read at block ${blocksRead}/${this.blockCount}: ${prefixRead} bytes`)
            }
            this._pos += RECORD_PREFIX

            const blockSize = this._prefixBuf.readUInt32LE(0)
            const height    = this._prefixBuf.readUInt32LE(4)

            if (blockSize === 0 || blockSize > MAX_BLOCK_SIZE) {
                this._fail(`invalid block_size ${blockSize} at height ${height}`)
            }
            if (height !== prevHeight + 1) {
                this._fail(`height gap: expected ${prevHeight + 1}, got ${height}`)
            }
            prevHeight = height

            // Fresh copy so caller can retain it across iterations.
            const blockHash = Buffer.from(this._prefixBuf.slice(8, 40))

            if (blockSize > this._dataBuf.length) {
                this._dataBuf = Buffer.alloc(blockSize)
            }
            const dataRead = fs.readSync(this._fd, this._dataBuf, 0, blockSize, this._pos)
            if (dataRead !== blockSize) {
                this._fail(`short data read at height ${height}: expected ${blockSize}, got ${dataRead}`)
            }
            this._pos += blockSize

            // VIEW into scratch — invalidated next iteration.
            const blockBytes = this._dataBuf.slice(0, blockSize)

            yield { height, blockHash, blockBytes }
            blocksRead++
        }
    }

    close() {
        if (this._closed) return
        this._closed = true
        try { fs.closeSync(this._fd) } catch (_) {}
    }
}

module.exports = {
    XdmpReader,
    HEADER_SIZE,
    RECORD_PREFIX,
    MAX_BLOCK_SIZE,
    MAGIC_DUMP,
    CHAIN_NAMES,
    NETWORK_NAMES,
}
