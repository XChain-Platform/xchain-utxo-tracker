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
 * XChain UTXO Tracker - UTXO Tracker Class
 *
 ********************************************************************/

const { createHash } = require('crypto')
const util = require('../common/util')
const { DEBUG_TRACE } = require('./constants.js')
const XChainUtxoTracker = require('../XChainUtxoTracker.js')

async function parseTransactionInputs(db, transaction, blockHash, nextTxId8, addHints, removeSpent) {
        // Process all inputs concurrently (each input has its own hash buffer so
        // the in-place .reverse() calls don't interfere between parallel closures
        const inputCounts = await Promise.all(transaction.ins.map(async (nextInput) => {
            const standardInput = ("standard_input" in nextInput ? nextInput["standard_input"] : true)

            // A coinbase input spends nothing, so there is no previous output to trace.
            if ((nextInput.index === 4294967295) || !standardInput) { //4294967295 = 0xFFFFFFFF. It's a Coinbase input, there's no need to trace it
                return 0
            }

            // Reverse the wire-order (little-endian) hash to big-endian display
            // order on a COPY of the buffer. .reverse() mutates in place, and
            // nextInput.hash is shared: the same decoded tx can be parsed again
            // on a later path (e.g. mempool ingest, then block confirmation).
            // Mutating it here would (a) double-reverse within this call,
            // corrupting the hint record's prevTxHash, and (b) leave the buffer
            // flipped for the downstream re-parse, breaking its spend lookup.
            // Buffer.from() copies, so the source bytes stay untouched and the
            // same hex feeds insertInput, the hint, and the removeSpent lookup.
            const prevTxHashHex = util.uint8ArrayToHex(Buffer.from(nextInput.hash).reverse())

            if (removeSpent){
                let prevTxHash8 = prevTxHashHex.substring(0, 16)
                await db.removeOutputWithInput({prevTxHash:prevTxHash8, prevOutputIndex:nextInput.index, blockHash:blockHash})
            } else {
                await db.insertInput({
                    prevTxHash:prevTxHashHex,
                    prevOutputIndex:nextInput.index,
                    txHash:nextTxId8
                })
            }

            if (addHints){
                await db.insertInputHint({
                    prevTxHash:prevTxHashHex,
                    prevOutputIndex:nextInput.index,
                    txHash:nextTxId8
                })
            }

            return 1
        }))

        return inputCounts
}

async function parseTransactionOutputs(db, transaction, blockHash, blockHeight, nextTxId, nextTxId8, isCoinbase, addHints, removeSpent) {
        // Process all outputs concurrently (each output is fully independent
        await Promise.all(transaction.outs.map(async (nextOutput, txOutputIndex) => {
            const scriptHash = createHash('sha256').update(nextOutput.script).digest('hex')

            await db.insertOutput({scriptPubKey:scriptHash, txHash:nextTxId8, outputIndex:txOutputIndex, value:nextOutput.value, height:blockHeight, fullTxHash:nextTxId, coinbase:isCoinbase})

            if (addHints || removeSpent){
                await db.insertOutputHint({scriptPubKey:scriptHash, txHash:nextTxId8, outputIndex:txOutputIndex})
                await db.insertOutputScriptBlock(scriptHash, blockHash, blockHeight)
                await db.insertOutputBlock({scriptPubKey:scriptHash, txHash:nextTxId8, outputIndex:txOutputIndex, blockHash})
            }
        }))
}

module.exports = {
    async parseTransaction(db, transaction, blockHash, blockHeight = -1, addHints = false, removeSpent = false){
        let nextTxId = null
        if ("id" in transaction){ //Some transactions are changed for bitcoinjs-lib to parse them. The original hash of the transaction get stored in the "id" property
            nextTxId = transaction["id"]
        } else {
            nextTxId = transaction.getId()
        }

        let nextTxId8 = nextTxId.substring(0,16)

        let resultInfo = {
            inputsCount: 0,
            outputsCount: 0
        }

        const isCoinbase = XChainUtxoTracker.isCoinbaseTransaction(transaction)

        if (!removeSpent) {
            await db.insertTransaction({hash:nextTxId, blockHash:blockHash})
        }

        const inputCounts = await parseTransactionInputs(db, transaction, blockHash,
            nextTxId8, addHints, removeSpent)

        await parseTransactionOutputs(db, transaction, blockHash, blockHeight,
            nextTxId, nextTxId8, isCoinbase, addHints, removeSpent)

        resultInfo["inputsCount"]  = inputCounts.reduce((acc, n) => acc + n, 0)
        resultInfo["outputsCount"] = transaction.outs.length

        return resultInfo
    },

    // Pass 1 of two-pass block processing: insert all outputs (and the tx record).
    // Must complete for ALL transactions before parseTxInputs runs, so that
    // removeOutputWithInput can find same-block outputs in transactionArray.
    async parseTxOutputs(db, transaction, blockHash, blockHeight, addHints, removeSpent){
        const nextTxId  = "id" in transaction ? transaction["id"] : transaction.getId()
        const nextTxId8 = nextTxId.substring(0, 16)
        const isCoinbase = XChainUtxoTracker.isCoinbaseTransaction(transaction)
        const _tt = XChainUtxoTracker.parseOutBuckets

        if (!removeSpent) {
            await db.insertTransaction({hash: nextTxId, blockHash: blockHash})
        }

        // Sequential in vout order so that insertOutputScriptBlock writes the
        // S-record for the first (smallest vout) occurrence of a scriptHash:
        // matching bulk-sync's block-tx-vout-ordered dedup. Concurrent Promise.all
        // here raced, producing non-deterministic S-record winners.
        for (let txOutputIndex = 0; txOutputIndex < transaction.outs.length; txOutputIndex++) {
            const nextOutput = transaction.outs[txOutputIndex]
            const _h0 = DEBUG_TRACE ? Date.now() : 0
            // Keep the hash as a Buffer: insertOutput / insertOutputHint /
            // insertOutputScriptBlock all accept Buffers and use buf.copy()
            // instead of decoding a hex string back into bytes.
            const scriptHash = createHash('sha256').update(nextOutput.script).digest()
            if (DEBUG_TRACE) _tt.hash += Date.now() - _h0

            const _i0 = DEBUG_TRACE ? Date.now() : 0
            await db.insertOutput({scriptPubKey: scriptHash, txHash: nextTxId8, outputIndex: txOutputIndex, value: nextOutput.value, height: blockHeight, fullTxHash: nextTxId, coinbase: isCoinbase})
            if (DEBUG_TRACE) _tt.ins += Date.now() - _i0

            if (addHints || removeSpent) {
                const _i1 = DEBUG_TRACE ? Date.now() : 0
                await db.insertOutputHint({scriptPubKey: scriptHash, txHash: nextTxId8, outputIndex: txOutputIndex})
                if (DEBUG_TRACE) _tt.ins += Date.now() - _i1

                const _s0 = DEBUG_TRACE ? Date.now() : 0
                await db.insertOutputScriptBlock(scriptHash, blockHash, blockHeight)
                if (DEBUG_TRACE) _tt.sb += Date.now() - _s0

                await db.insertOutputBlock({scriptPubKey: scriptHash, txHash: nextTxId8, outputIndex: txOutputIndex, blockHash})
            }
        }

        return transaction.outs.length
    },

    // Pass 2 of two-pass block processing: process all inputs.
    // By the time this runs, all same-block outputs are already in transactionArray,
    // so removeOutputWithInput will resolve intra-block spends correctly.
    async parseTxInputs(db, transaction, blockHash, addHints, removeSpent){
        const nextTxId  = "id" in transaction ? transaction["id"] : transaction.getId()
        const nextTxId8 = nextTxId.substring(0, 16)

        const inputCounts = await Promise.all(transaction.ins.map(async (nextInput) => {
            const standardInput = ("standard_input" in nextInput ? nextInput["standard_input"] : true)

            // A coinbase input spends nothing, so there is no previous output to trace.
            if ((nextInput.index === 4294967295) || !standardInput) { //4294967295 = 0xFFFFFFFF. It's a Coinbase input, there's no need to trace it
                return 0
            }

            // Reverse the wire-order (little-endian) hash to big-endian display
            // order on a COPY of the buffer. .reverse() mutates in place, and
            // nextInput.hash is shared: the same decoded tx can be parsed again
            // on a later path (e.g. mempool ingest, then block confirmation).
            // Mutating it here would (a) double-reverse within this call,
            // corrupting the hint record's prevTxHash, and (b) leave the buffer
            // flipped for the downstream re-parse, breaking its spend lookup.
            // Buffer.from() copies, so the source bytes stay untouched and the
            // same hex feeds insertInput, the hint, and the removeSpent lookup.
            const prevTxHashHex = util.uint8ArrayToHex(Buffer.from(nextInput.hash).reverse())

            if (removeSpent) {
                const prevTxHash8 = prevTxHashHex.substring(0, 16)
                await db.removeOutputWithInput({prevTxHash: prevTxHash8, prevOutputIndex: nextInput.index, blockHash: blockHash})
            } else {
                await db.insertInput({
                    prevTxHash: prevTxHashHex,
                    prevOutputIndex: nextInput.index,
                    txHash: nextTxId8
                })
            }

            if (addHints) {
                await db.insertInputHint({
                    prevTxHash: prevTxHashHex,
                    prevOutputIndex: nextInput.index,
                    txHash: nextTxId8
                })
            }

            return 1
        }))

        return inputCounts.reduce((acc, n) => acc + n, 0)
    }
}
