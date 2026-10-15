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
 * XChain UTXO Tracker - Block Decoder Class
 * 
 * This file handles decoding blocks and block transactions
 *
 ********************************************************************/

// Load required libraries
const crypto = require('crypto');
const bitcoinjs = require('bitcoinjs-lib');
// BigInt-safe 64-bit reader/writer, applied in-process so a >2^53-1 sat DOGE
// output cannot wedge block decode even when the Dockerfile COPY patch is absent.
const bufferutils_js_1 = require('./apply_bufferutils_patch');
const transaction_js_1 = require('bitcoinjs-lib/src/transaction');
const coins = require('../coins');

const LITECOIN_HOGEX_FLAG = 0x08
const LITECOIN_MWEB_SEGWIT_FLAG = 0x09

class TransactionParseError extends Error {
    constructor(message, cause) {
        super(message, cause ? { cause } : undefined)
        this.name = 'TransactionParseError'
        this.code = 'ERR_TRANSACTION_PARSE'
    }
}

function transactionParseError(message, cause) {
    if (cause instanceof TransactionParseError) return cause
    return new TransactionParseError(message, cause)
}

// Block/tx wire-serialization families this decoder actually implements. The
// branches below (Litecoin 'mweb' MWEB-flagged tx reading, Dogecoin 'auxpow'
// stripped upstream in the fetch path, 'default' plain bitcoinjs) are keyed on
// the coin's declared wireFormat from the canonical coin registry (src/coins)
// rather than a hardcoded coin-name list. A coin absent from the registry, or
// carrying a family this file does not implement, fails loudly at construction
// instead of silently falling through to the strict default parser and
// misparsing at its first AuxPoW/MWEB block. xchain-decoder's twin of this file
// enforces the same contract, so onboarding a chain cannot leave one side of
// the seam fail-loud and the other fail-silent.
const HANDLED_WIRE_FORMATS = new Set(['default', 'mweb', 'auxpow'])

// Litecoin's flagged transaction serialization (litecoin src/primitives/transaction.h
// SerializeTransaction): version | 0x00 marker | flags | vin | vout | witness when
// flags & 1 | mweb_tx when flags & 8 | nLockTime. The readers below walk it with
// bounds checks so a short buffer fails by name instead of over-reading.
// Keep in sync with xchain-decoder/src/chain/XChainBlockDecoder.js: every function from
// mwebShortError through assertBlockBodyIntact is byte-identical in both repos, and
// xchain-utxo-tracker/test/unit/block_decoder_twin_parity.test.js compares verdicts.
function mwebShortError(what) {
    return new Error('MWEB tx parse: buffer too short for ' + what)
}

function skipMwebBytes(buf, offset, count, what) {
    if (count > buf.length - offset) throw mwebShortError(what)
    return offset + count
}

// A CompactSize at offset, as { value, end }.
function readMwebCompactSize(buf, offset, what) {
    if (offset >= buf.length) throw mwebShortError(what)
    const first = buf[offset]
    if (first < 0xFD) return { value: first, end: offset + 1 }
    const width = first === 0xFD ? 2 : first === 0xFE ? 4 : 8
    const end = skipMwebBytes(buf, offset + 1, width, what)
    if (width === 2) return { value: buf.readUInt16LE(offset + 1), end }
    if (width === 4) return { value: buf.readUInt32LE(offset + 1), end }
    const value = buf.readBigUInt64LE(offset + 1)
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new TransactionParseError('MWEB tx parse: ' + what + ' exceeds Number.MAX_SAFE_INTEGER')
    }
    return { value: Number(value), end }
}

function skipMwebVarBytes(buf, offset, what) {
    const length = readMwebCompactSize(buf, offset, what)
    return skipMwebBytes(buf, length.end, length.value, what)
}

// Where vin and vout end, where vout starts, and the input count the witness needs.
function skipMwebInsAndOuts(buf, offset) {
    const ins = readMwebCompactSize(buf, offset, 'input count')
    offset = ins.end
    for (let i = 0; i < ins.value; i++) {
        offset = skipMwebBytes(buf, offset, 36, 'input prevout')
        offset = skipMwebVarBytes(buf, offset, 'input script')
        offset = skipMwebBytes(buf, offset, 4, 'input sequence')
    }
    const outsStart = offset
    const outs = readMwebCompactSize(buf, offset, 'output count')
    offset = outs.end
    for (let i = 0; i < outs.value; i++) {
        offset = skipMwebBytes(buf, offset, 8, 'output value')
        offset = skipMwebVarBytes(buf, offset, 'output script')
    }
    return { end: offset, outsStart, nIns: ins.value }
}

function skipMwebWitness(buf, offset, nIns) {
    for (let i = 0; i < nIns; i++) {
        const items = readMwebCompactSize(buf, offset, 'witness item count')
        offset = items.end
        for (let j = 0; j < items.value; j++) offset = skipMwebVarBytes(buf, offset, 'witness item')
    }
    return offset
}

// True when the tx at buf[offset] is version 1 or 2 with the 0x00 marker and flag
// 0x08 (MWEB) or 0x09 (witness and MWEB): the forms this decoder reads itself.
function hasMwebFlag(buf, offset) {
    if (buf.length - offset < 6) return false
    const version = buf.readUInt32LE(offset)
    const flag = buf[offset + 5]
    return (version === 1 || version === 2) && buf[offset + 4] === 0x00 &&
        (flag === LITECOIN_HOGEX_FLAG || flag === LITECOIN_MWEB_SEGWIT_FLAG)
}

// bitcoinjs reads an empty input count followed by 0x01 as the segwit marker, so a
// tx with no transparent inputs is built field by field rather than re-parsed.
function buildInputlessTransaction(buf, start, outsStart, lockTimeAt) {
    const tx = new bitcoinjs.Transaction()
    tx.version = buf.readInt32LE(start)
    const outs = readMwebCompactSize(buf, outsStart, 'output count')
    let offset = outs.end
    for (let i = 0; i < outs.value; i++) {
        // The same unsigned BigInt the patched bufferutils reader gives every output value.
        const value = buf.readBigUInt64LE(offset)
        const script = readMwebCompactSize(buf, offset + 8, 'output script')
        offset = script.end + script.value
        tx.outs.push({ script: Buffer.from(buf.subarray(script.end, offset)), value })
    }
    tx.locktime = buf.readUInt32LE(lockTimeAt)
    return tx
}

// Read one MWEB-flagged tx at buf[start]. Returns it without its MWEB part, so
// getId() is Litecoin's ComputeHash (no witness, no MWEB) and the witness, where a
// P2WSH carrier keeps its payload, survives; plus the bytes consumed. mweb_tx is an
// OptionalPtr: tag 0x00 means no MWEB part (the HogEx), any other tag starts an
// MWEB::Tx body this file does not parse. A standalone tx (getrawtransaction) ends
// with its nLockTime, so the body runs to four bytes before the end; inside a block
// nothing records the body's length, so a non-null MWEB part there is refused.
function readMwebFlaggedTransaction(buf, start, standalone) {
    const withWitness = (buf[start + 5] & 1) === 1
    const insOuts = skipMwebInsAndOuts(buf, start + 6)
    const witnessEnd = withWitness ? skipMwebWitness(buf, insOuts.end, insOuts.nIns) : insOuts.end
    let lockTimeAt = skipMwebBytes(buf, witnessEnd, 1, 'MWEB tag')
    if (buf[witnessEnd] !== 0x00) {
        if (!standalone) throw new Error('MWEB tx parse: a non-null MWEB part inside a block has no recorded length')
        if (buf.length - 4 < lockTimeAt) throw mwebShortError('locktime')
        lockTimeAt = buf.length - 4
    }
    const end = skipMwebBytes(buf, lockTimeAt, 4, 'locktime')
    if (insOuts.nIns === 0) {
        return { tx: buildInputlessTransaction(buf, start, insOuts.outsStart, lockTimeAt), consumed: end - start }
    }
    const plain = Buffer.concat([
        buf.subarray(start, start + 4),
        Buffer.from(withWitness ? [0x00, 0x01] : []),
        buf.subarray(start + 6, witnessEnd),
        buf.subarray(lockTimeAt, end),
    ])
    return { tx: bitcoinjs.Transaction.fromBuffer(plain), consumed: end - start }
}

// bitcoinjs Block.fromBuffer checks neither the merkle root nor what follows the
// last transaction, so a parsed block body is held to three things here: at least
// one transaction (the coinbase), txids that hash to the header's merkle root, and
// no bytes after the last transaction except where Litecoin writes the MWEB
// extension block, after a HogEx in last place.
function assertBlockBodyIntact(block, bufferLength, bodyEnd, extensionFollows) {
    const txs = block.transactions || []
    if (txs.length < 1) throw new Error('Block holds no transactions')
    if (bodyEnd !== bufferLength && !extensionFollows) {
        throw new Error('Block has ' + (bufferLength - bodyEnd) + ' bytes after its last transaction')
    }
    if (!bitcoinjs.Block.calculateMerkleRoot(txs).equals(block.merkleRoot)) {
        throw new Error('Block merkle root mismatch: the header root is not the root of its transactions')
    }
}

/**
 * Parse an MWEB block header from a buffer: reads the version, prev hash,
 * merkle root, timestamp, bits and nonce fields in order. Returns the populated
 * block object together with the bufferReader positioned after the header so
 * callers can continue decoding the transaction payload.
 */
function readMwebBlockHeader(buffer){
    if (buffer.length < 80) throw new Error('Buffer too small (< 80 bytes)');
    const bufferReader = new bufferutils_js_1.BufferReader(buffer);
    const block = new bitcoinjs.Block();
    block.version = bufferReader.readInt32();
    block.prevHash = bufferReader.readSlice(32);
    block.merkleRoot = bufferReader.readSlice(32);
    block.timestamp = bufferReader.readUInt32();
    block.bits = bufferReader.readUInt32();
    block.nonce = bufferReader.readUInt32();
    return { bufferReader, block };
}

function readMwebTransaction(bufferReader){
    const tx = transaction_js_1.Transaction.fromBuffer(
        bufferReader.buffer.slice(bufferReader.offset),
        true,
    );
    bufferReader.offset += tx.byteLength();
    return tx;
}

function validateMwebTransactionCount(bufferReader, nTransactions){
    // Sanity-bound the claimed tx count against the bytes actually
    // present: the smallest possible serialized transaction is well
    // over 10 bytes, so a varint claiming more than remaining/10
    // transactions is structurally impossible. Without this, a forged
    // count only failed later via a buffer over-read inside
    // Transaction.fromBuffer, which has an unguarded loop with an incidental
    // unnamed exit. Block bytes reach here from the trusted node AND from
    // a bulk-sync .xdmp dump (bulk_sync/parse-worker.js), so this also keeps
    // the tracker fail-closed on the same forged input the decoder twin
    // already rejects by name.
    const remainingBytes = bufferReader.buffer.length - bufferReader.offset;
    if (nTransactions > remainingBytes / 10) {
        throw new Error('Block declares ' + nTransactions + ' transactions but only ' +
            remainingBytes + ' bytes remain (invalid transaction count)');
    }
}

// Reads the block's transactions and reports whether the last one is MWEB-flagged,
// the only place Litecoin writes the MWEB extension block after it.
function readMwebTransactions(bufferReader, block, nTransactions){
    block.transactions = [];
    let hogExLast = false
    for (let i = 0; i < nTransactions; ++i) {
        // Only the last tx can be the HogEx, which Litecoin writes with the MWEB
        // flag; it is read whole, so its nLockTime and txid are its real ones.
        if (i == nTransactions - 1 && hasMwebFlag(bufferReader.buffer, bufferReader.offset)) {
            const read = readMwebFlaggedTransaction(bufferReader.buffer, bufferReader.offset, false)
            bufferReader.offset += read.consumed
            block.transactions.push(read.tx)
            hogExLast = true
        } else {
            block.transactions.push(readMwebTransaction(bufferReader))
        }
    }
    return hogExLast
}

class XChainBlockDecoder {

    // Callers tell a wire-parse failure apart by this class, reached through the one
    // export, so the module keeps a single export shape.
    static TransactionParseError = TransactionParseError;

    constructor(networkName) {
        let networkNameSplit = networkName.split("-")
        this.coin = networkNameSplit[0]
        const tick = coins.FULL_NAME_TO_TICK[this.coin]
        this.wireFormat = tick ? coins.WIRE_FORMAT[tick] : undefined
        if (!this.wireFormat || !HANDLED_WIRE_FORMATS.has(this.wireFormat)) {
            throw new Error(
                'XChainBlockDecoder: no block/tx wire-format contract declared for coin "' + this.coin +
                '" (network "' + networkName + '"). Declare a handled wireFormat (default/mweb/auxpow) ' +
                'on the coin in src/coins before onboarding the chain.')
        }
    }

    blockFromHex(blockHex){
        return this.blockFromBuffer(Buffer.from(blockHex,"hex"))
    }
    
    doubleSha256AndReverse(data){
        const firstHash = crypto.createHash('sha256').update(data).digest();
        const secondHash = crypto.createHash('sha256').update(firstHash).digest();
        const reversedHash = Buffer.from(secondHash).reverse();
        return reversedHash;
    }
    
    txFromHex(hexString){
        try {
            if (typeof hexString !== 'string' || hexString.length === 0 || (hexString.length % 2) !== 0 || !/^[0-9a-fA-F]+$/.test(hexString)) {
                throw new TransactionParseError('Transaction hex must be a non-empty, even-length hexadecimal string')
            }
            const buffer = Buffer.from(hexString, "hex")
            if (this.wireFormat === "mweb" && hasMwebFlag(buffer, 0)) {
                // Litecoin's getrawtransaction answers in the MWEB serialization when the
                // tx has an MWEB part; bitcoinjs cannot read that flag, so read it here.
                const parsed = readMwebFlaggedTransaction(buffer, 0, true)
                if (parsed.consumed !== buffer.length) {
                    throw new TransactionParseError('Transaction has ' + (buffer.length - parsed.consumed) + ' trailing byte(s)')
                }
                return parsed.tx
            }
            const tx = transaction_js_1.Transaction.fromBuffer(buffer, true)
            if (tx.byteLength() !== buffer.length) {
                throw new TransactionParseError('Transaction has ' + (buffer.length - tx.byteLength()) + ' trailing byte(s)')
            }
            return tx
        } catch (err) {
            throw transactionParseError('Transaction parse failed: ' + (err && err.message ? err.message : err), err)
        }
    }
    
    blockFromBuffer(buffer){
        switch(this.wireFormat){
            case "mweb":
                const { bufferReader, block } = readMwebBlockHeader(buffer);
                if (buffer.length === 80) return block;
                const nTransactions = bufferReader.readVarInt();
                validateMwebTransactionCount(bufferReader, nTransactions);
                let extensionFollows;
                try {
                    extensionFollows = readMwebTransactions(bufferReader, block, nTransactions);
                } catch (err) {
                    throw transactionParseError('Block transaction parse failed: ' + (err && err.message ? err.message : err), err)
                }
                assertBlockBodyIntact(block, buffer.length, bufferReader.offset, extensionFollows);
                const witnessCommit = block.getWitnessCommit();
                // This Block contains a witness commit
                if (witnessCommit) block.witnessCommit = witnessCommit;
                return block;
            default: {
                let plainBlock
                try {
                    plainBlock = bitcoinjs.Block.fromBuffer(buffer)
                } catch (err) {
                    throw transactionParseError('Block transaction parse failed: ' + (err && err.message ? err.message : err), err)
                }
                // An 80-byte buffer is a header-only parse, with no body to check.
                if (buffer.length === 80) return plainBlock
                assertBlockBodyIntact(plainBlock, buffer.length, plainBlock.byteLength(), false)
                return plainBlock
            }
        }
    }
}

module.exports = XChainBlockDecoder;
