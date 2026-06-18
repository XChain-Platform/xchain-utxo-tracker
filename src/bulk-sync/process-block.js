'use strict'

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
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
 * XChain UTXO Tracker - Bulk Sync Block Processor
 *
 * Pure transformation: takes a decoded block (output of XChainBlockDecoder)
 * plus its height and display-order blockHash, and writes records to three
 * streams via the writers in ./writers.js. No I/O beyond the writers. No
 * state across calls. See SPEC.md for the target record layouts.
 *
 ********************************************************************/

const crypto = require('crypto')

function reverseBytes32(src) {
    const out = Buffer.alloc(32)
    for (let i = 0; i < 32; i++) out[i] = src[31 - i]
    return out
}

function sha256(buf) {
    return crypto.createHash('sha256').update(buf).digest()
}

/**
 * @param {Object} block           decoded block from XChainBlockDecoder.blockFromHex()
 * @param {number} height          block height (decoder doesn't know it; dumper supplies it)
 * @param {Buffer} blockHash       32B display-order hash (from .xdmp record header)
 * @param {Object} writers         { outputs: OutputsWriter, spends: SpendsWriter, meta: MetaWriter }
 * @returns {{txs:number, outputs:number, spends:number}}
 */
function processBlock(block, height, blockHash, writers) {
    // block.prevHash is bitcoinjs-lib internal LE (reverse to get display order).
    // Clone instead of mutating; defensive against the decoder reusing the block.
    const previousHash = reverseBytes32(block.prevHash)

    const txs       = block.transactions
    const txCount   = txs.length
    const txHash8List = new Array(txCount)

    let outputsEmitted = 0
    let spendsEmitted  = 0

    for (let i = 0; i < txCount; i++) {
        const tx = txs[i]

        // Prefer tx.id (populated by decoder for altered txs like Litecoin HogEx).
        // Otherwise derive from bitcoinjs-lib getHash() (internal LE) and reverse.
        let fullTxHash
        if (tx.id) {
            fullTxHash = Buffer.from(tx.id, 'hex')
        } else {
            fullTxHash = reverseBytes32(tx.getHash())
        }
        const txHash8 = fullTxHash.slice(0, 8)
        txHash8List[i] = txHash8

        const outs = tx.outs
        for (let vout = 0; vout < outs.length; vout++) {
            const o = outs[vout]
            const scriptHash = sha256(o.script)
            writers.outputs.append(
                txHash8,
                vout,
                o.value,
                height,
                fullTxHash,
                scriptHash,
                blockHash,
            )
            outputsEmitted++
        }

        const ins = tx.ins
        for (let k = 0; k < ins.length; k++) {
            const inp = ins[k]
            if (inp.index === 0xFFFFFFFF) continue
            // inp.hash is 32B LE internal. We need only the first 8 bytes of the
            // display-order hash, so read the last 8 bytes of LE in reverse.
            const prevLE  = inp.hash
            const prevHash8 = Buffer.alloc(8)
            for (let j = 0; j < 8; j++) prevHash8[j] = prevLE[31 - j]
            writers.spends.append(prevHash8, inp.index, txHash8)
            spendsEmitted++
        }
    }

    writers.meta.writeBlock(height, block.timestamp, blockHash, previousHash, txHash8List)

    return { txs: txCount, outputs: outputsEmitted, spends: spendsEmitted }
}

module.exports = { processBlock }
