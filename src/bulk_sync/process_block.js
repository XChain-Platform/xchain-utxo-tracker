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

function appendOutputs(tx, txid, height, blockHash, writer) {
    const ins = tx.ins
    // Coinbase = the block's generation tx: exactly one input whose prevout
    // index is 0xFFFFFFFF (same marker the input loop below skips). Mirrors
    // XChainUtxoTracker.isCoinbaseTransaction so bulk-sync flags coinbase
    // outputs identically to the live path, driving maturity gating.
    const isCoinbase = ins.length === 1 && ins[0] && ins[0].index === 0xFFFFFFFF
    let emitted = 0
    const outs = tx.outs
    for (let vout = 0; vout < outs.length; vout++) {
        const o = outs[vout]
        const scriptHash = sha256(o.script)
        writer.append(
            txid,
            vout,
            o.value,
            height,
            scriptHash,
            blockHash,
            isCoinbase,
        )
        emitted++
    }
    return emitted
}

function appendSpends(ins, txid, writer) {
    let emitted = 0
    for (let k = 0; k < ins.length; k++) {
        const inp = ins[k]
        // Same spend rule as the live parseTxInputs: skip coinbase and any input with a falsy standard_input.
        const standardInput = ("standard_input" in inp ? inp["standard_input"] : true)
        if ((inp.index === 0xFFFFFFFF) || !standardInput) continue
        // inp.hash is 32B LE internal; the record carries the display-order txid,
        // the same bytes the live path reads as the input's prev txid.
        writer.append(reverseBytes32(inp.hash), inp.index, txid)
        emitted++
    }
    return emitted
}

function processTransaction(tx, height, blockHash, writers) {
    // The txid comes from bitcoinjs-lib getHash() (internal LE), reversed; the live
    // path reads tx.getId(), the same bytes in display order.
    const txid = reverseBytes32(tx.getHash())
    const outputs = appendOutputs(tx, txid, height, blockHash, writers.outputs)
    const spends = appendSpends(tx.ins, txid, writers.spends)
    return { txid, outputs, spends }
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
    const txs = block.transactions
    const txidList = new Array(txs.length)
    let outputsEmitted = 0
    let spendsEmitted  = 0
    for (let i = 0; i < txs.length; i++) {
        const result = processTransaction(txs[i], height, blockHash, writers)
        txidList[i] = result.txid
        outputsEmitted += result.outputs
        spendsEmitted += result.spends
    }
    writers.meta.writeBlock(height, block.timestamp, blockHash, previousHash, txidList)
    return { txs: txs.length, outputs: outputsEmitted, spends: spendsEmitted }
}

module.exports = { processBlock }
