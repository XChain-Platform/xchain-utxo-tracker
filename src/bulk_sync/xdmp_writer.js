'use strict'

/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain UTXO Tracker - Bulk Sync .xdmp Writer
 *
 * Writes the .xdmp header and block records dump.js streams to disk. The
 * byte layout is documented in dump.js's header and read back by
 * xdmp_reader.js.
 *
 ********************************************************************/

const fs = require('fs')

const MAGIC               = Buffer.from('XCHNDMP1', 'ascii')
const HEADER_SIZE         = 64
const FILE_VERSION        = 1
const MAX_BLOCK_SIZE      = 32 * 1024 * 1024

const CHAIN_CODES   = { bitcoin: 1, litecoin: 2, dogecoin: 3 }
const NETWORK_CODES = { mainnet: 1, testnet: 2, regtest: 3 }

function makeHeader(chain, netName, firstHeight, lastHeight, chainTipAtDump) {
    const buf = Buffer.alloc(HEADER_SIZE)
    MAGIC.copy(buf, 0)
    buf.writeUInt8(CHAIN_CODES[chain],    8)
    buf.writeUInt8(NETWORK_CODES[netName], 9)
    buf.writeUInt16LE(FILE_VERSION,       10)
    buf.writeUInt32LE(firstHeight,        12)
    buf.writeUInt32LE(lastHeight,         16)
    buf.writeUInt32LE(lastHeight - firstHeight + 1, 20)
    buf.writeUInt32LE(chainTipAtDump,     24)
    // bytes 28..63 = reserved, already zeroed by Buffer.alloc
    return buf
}

function chunkFileName(chain, netName, start, end) {
    const s = String(start).padStart(8, '0')
    const e = String(end).padStart(8, '0')
    return `blocks-${chain}-${netName}-${s}-${e}.xdmp`
}

function writeDumpHeader(fd, args, chunkStart, chunkEnd, chainTipAtDump) {
    const header = makeHeader(args.chain, args.netName, chunkStart, chunkEnd, chainTipAtDump)
    fs.writeSync(fd, header, 0, HEADER_SIZE)
    return HEADER_SIZE
}

function writeBlockRecords(fd, blocks) {
    let bytesWritten = 0
    for (const { height, hash, hex } of blocks) {
        const blockBytes = Buffer.from(hex, 'hex')
        if (blockBytes.length === 0 || blockBytes.length > MAX_BLOCK_SIZE) {
            throw new Error(`block ${height} has invalid size ${blockBytes.length}`)
        }
        const hashBytes = Buffer.from(hash, 'hex')
        if (hashBytes.length !== 32) {
            throw new Error(`block ${height} has invalid hash length ${hashBytes.length}`)
        }
        const record = Buffer.alloc(40)
        record.writeUInt32LE(blockBytes.length, 0)
        record.writeUInt32LE(height, 4)
        hashBytes.copy(record, 8)
        fs.writeSync(fd, record, 0, 40)
        fs.writeSync(fd, blockBytes, 0, blockBytes.length)
        bytesWritten += 40 + blockBytes.length
    }
    return bytesWritten
}

module.exports = {
    CHAIN_CODES,
    NETWORK_CODES,
    chunkFileName,
    writeDumpHeader,
    writeBlockRecords,
}
