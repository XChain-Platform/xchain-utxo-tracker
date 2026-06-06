/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available —
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
const bufferutils_js_1 = require('bitcoinjs-lib/src/bufferutils');
const transaction_js_1 = require('bitcoinjs-lib/src/transaction');

const LITECOIN_HOGEX_FLAG = 0x08
const LITECOIN_MWEB_SEGWIT_FLAG = 0x09

class XChainBlockDecoder {
    
    constructor(networkName) {
        let networkNameSplit = networkName.split("-")
        this.coin = networkNameSplit[0]
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
        switch(this.coin){
            case "litecoin":
                let littleEndianTxVersion = hexString.substr(0, 8)
                let marker = hexString.substr(8, 2)
                let flag = hexString.substr(10, 2)
                        
                if (
                    (
                        (littleEndianTxVersion == "01000000") 
                        ||
                        (littleEndianTxVersion == "02000000")
                    ) && 
                    (marker == "00") && 
                    (
                        (flag == "08") 
                        || 
                        (flag == "09")
                    )
                ){
                    hexString = hexString.substr(0, 8) + hexString.substr(12)
                }
            default:
                const tx = transaction_js_1.Transaction.fromBuffer(
                    Buffer.from(hexString,"hex"),
                    true
                );
                return tx;
        }
    }
    
    blockFromBuffer(buffer){
        switch(this.coin){
            case "litecoin":
                
                /**
                *   This piece of code is the same as bitcoinjs-lib Block.fromBuffer with some changes for litecoin
                */
                if (buffer.length < 80) throw new Error('Buffer too small (< 80 bytes)');
                const bufferReader = new bufferutils_js_1.BufferReader(buffer);
                const block = new bitcoinjs.Block();
                block.version = bufferReader.readInt32();
                block.prevHash = bufferReader.readSlice(32);
                block.merkleRoot = bufferReader.readSlice(32);
                block.timestamp = bufferReader.readUInt32();
                block.bits = bufferReader.readUInt32();
                block.nonce = bufferReader.readUInt32();
                if (buffer.length === 80) return block;
                const readTransaction = () => {
                  const tx = transaction_js_1.Transaction.fromBuffer(
                    bufferReader.buffer.slice(bufferReader.offset),
                    true,
                  );
                  bufferReader.offset += tx.byteLength();
                  return tx;
                };
                const nTransactions = bufferReader.readVarInt();
                block.transactions = [];
                for (let i = 0; i < nTransactions; ++i) {
                  try {
                    if (i == nTransactions - 1){//If it's the last transaction, then check if it's the HogEx
                        let nextTxBuffer = bufferReader.buffer.slice(bufferReader.offset)   
                        let txVersion = nextTxBuffer.readUInt32LE();
                        let marker = nextTxBuffer.readUInt8(4);
                        let flag = nextTxBuffer.readUInt8(5);
                        
                        if ((txVersion == 0x01 || txVersion == 0x02) && (marker == 0x00) && (flag == LITECOIN_HOGEX_FLAG || flag == LITECOIN_MWEB_SEGWIT_FLAG)){
                            let removeOffsetStart = bufferReader.offset + 4 //4 bytes for txVersion
                            let removeOffsetEnd = removeOffsetStart + 2 //2 bytes for marker + flag
                        
                            //Remove the marker+flag (0x08 pure-MWEB, or 0x09 segwit+MWEB), so bitcoinjs-lib parses this tx as a normal transaction
                            let bufferReaderBeforeFlag = bufferReader.buffer.slice(0, removeOffsetStart)
                            let bufferReaderAfterFlag = bufferReader.buffer.slice(removeOffsetEnd)
                            bufferReader.buffer = Buffer.concat([bufferReaderBeforeFlag, bufferReaderAfterFlag])
                        
                        }
                    }
                    
                    let tx = readTransaction();
                    block.transactions.push(tx);
                  } catch (err){
                    throw err
                  }
                }
                const witnessCommit = block.getWitnessCommit();
                // This Block contains a witness commit
                if (witnessCommit) block.witnessCommit = witnessCommit;
                return block; 
            default:
                return bitcoinjs.Block.fromBuffer(buffer)
        }
    }
}

module.exports = XChainBlockDecoder