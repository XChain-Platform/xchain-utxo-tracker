/*********************************************************************
 * 
 * Copyright © 2025 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * Licensed under the Dankest Community License (Apache License 2.0 + Additional Terms).
 * You may not use this file except in compliance with that License.
 * 
 * A copy of the License is available at:
 *     https://dankest.llc/license
 *
 * This software is provided “AS IS”, without warranties or conditions of any kind.
 * 
 **********************************************************************
 *
 * XChain UTXO Tracker - UTXO Tracker Class
 * 
 * This file handles starting the UTXO tracker instance
 *
 ********************************************************************/

// Load required libraries
const util = require('./util')
const axios = require('axios');
axios.defaults.timeout = 5000
const BitcoinCore = require('bitcoin-core');
const crypto = require('crypto');
const bs58check = require('bs58check')
const bitcoin = require('bitcoinjs-lib')
const { createHash } = require('crypto');
const fs = require('fs')
const LevelUpStore = require('./LevelUpDb.js')
const BlockchainConnector = require('./BlockchainConnector.js')
const CryptoNetworks = require('./CryptoNetworks')
const XChainBlockDecoder = require('./XChainBlockDecoder')
const bs = require("binary-search")
const { hrtime } = require('node:process');

const CHECK_BLOCK_DELAY_MS = 1000 //1 second to continously ask for new block when all has been parsed
const DB_TRANSACTION_BLOCKS_QUANTITY = 100
const PARSE_MODE_FILES = 0
const PARSE_MODE_BULK_INSERTS = 1
const SYNCED_THRESHOLD = 3
const SATOSHI_UNIT = 100000000.0
const MEMPOOL_INTERVAL = 60000
const MEMPOOL_BATCH_SIZE = 1000
const REMOVE_SPENT = false

const UNDO_BLOCKS = 10 //This is the number of blocks from which the outputs will be kept saved.

class XChainUtxoTracker {
    constructor(network, nodeUrl, nodePort, nodeUser, nodePassword, dbName, auxPow) {
      this.network = CryptoNetworks.getBitcoinJsNetwork(network)
      this.connector = new BlockchainConnector(nodeUrl, nodePort, nodeUser, nodePassword)
      this.dbName = dbName
      
      this.db = null
      this.mempoolDb = null
      
      this.parseMode = PARSE_MODE_BULK_INSERTS
      this.xchainBlockDecoder = new XChainBlockDecoder(network)
      
      this.debugTime = {}
      
      this.synced = false
      
      this.blockchainInfoLastBlock = -1
      this.mempoolInterval = null
      this.mempoolBusy = false
      
      this.auxPow = auxPow
      this.lastBlocks = []
      
      this.keepParsing = true
    }
    
    async addToLastBlocks(blockHash){
        this.lastBlocks.push(blockHash)
        this.db.addLastStoredBlock(blockHash)
        
        while (this.lastBlocks.length > UNDO_BLOCKS){
            let nextBlockHash = this.lastBlocks.shift()
            
            await this.db.processDeletedOutputs(nextBlockHash, false)
            await this.db.removeLastStoredBlock(nextBlockHash)
        }
    }
    
    async removeFromLastBlocks(blockHash){
        if (this.lastBlocks.indexOf(blockHash) == this.lastBlocks.length-1){
            this.lastBlocks.pop()
            await this.db.removeLastStoredBlock(blockHash)
        } else {
            throw new Error("Can't delete a block from the 'last blocks' if it's not the last one")
        }
    }
    
    async sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    
    millisecondsToTimeString(ms){
        var milliseconds = Math.floor((ms % 1000) / 100),
        seconds = Math.floor((ms / 1000) % 60),
        minutes = Math.floor((ms / (1000 * 60)) % 60),
        hours = Math.floor((ms / (1000 * 60 * 60)) % 24);

        hours = (hours < 10) ? "0" + hours : hours;
        minutes = (minutes < 10) ? "0" + minutes : minutes;
        seconds = (seconds < 10) ? "0" + seconds : seconds;

        return hours + "h" + minutes + "m" + seconds + "." + milliseconds+"s";
    }
    
    isSynced(){
        return this.synced
    }
    
    async stopParsing(){
        return new Promise(async(resolve, reject) => {
            this.keepParsing = false
            let triesCount = 10
        
            while((!this.parsingStopped) && (triesCount > 0)){
                await this.sleep(1000)
                triesCount = triesCount - 1
            }
            
            if ((triesCount == 0) && (!this.parsingStopped)){
                reject("There was an error trying to stop the parsing")
            } else {    
                resolve(true)
            }
        })
    }
    
    getAddressType(address, network) {
        try {
            bitcoin.payments.p2pkh({ address, network })
            return 'p2pkh'
        } catch (e) {}

        try {
            bitcoin.payments.p2sh({ address, network });
            return 'p2sh'
        } catch (e) {}

        try {
            bitcoin.payments.p2wpkh({ address, network });
            return 'p2wpkh'
        } catch (e) {}

        try {
            bitcoin.payments.p2tr({ address, network });
            return 'p2tr';
        } catch (e) {}

        return "unknown"
    }
    
    async getBalanceInfo(address){
        let script = bitcoin.address.toOutputScript(address, this.network)
        let scriptHash = createHash('sha256').update(script).digest('hex')
        
        let confirmedBalance = 0
        let pendingBalance = 0
        let utxosConfirmed = 0
        let utxosPending = 0
        let totalReceived = 0
        
        let outputs = await this.db.getOutputsScriptPubKey(scriptHash)
        let mempoolOutputs = await this.mempoolDb.getOutputsScriptPubKey(scriptHash)
        outputs = outputs.concat(mempoolOutputs)
        
        let nextOutputIndex = 0
        while (nextOutputIndex < outputs.length){
            let mempoolTransaction = false
            let nextOutput = outputs[nextOutputIndex]
            
            let nextOutputTransactions = await this.db.getTransactions(nextOutput.txid) 
                
            if (nextOutputTransactions.length == 0){
                nextOutputTransactions = await this.mempoolDb.getTransactions(nextOutput.txid)  
                mempoolTransaction = true
            }
                
            if (nextOutputTransactions.length > 0){
                let nextOutputTransaction = nextOutputTransactions[0]
                let nextOutputBlock = await this.db.getBlock(nextOutputTransaction.block_hash)
                
                if (mempoolTransaction){
                    nextOutput.height = null
                    nextOutput.confirmations = 0
                } else {
                    if (nextOutputBlock != null){
                        nextOutput.height = nextOutputBlock.h
                        nextOutput.confirmations = this.blockchainInfoLastBlock - nextOutputBlock.h + 1
                    } else { //This means the block doesn't exists because it was removed by a reorg
                        outputs.splice(nextOutputIndex, 1)
                        continue
                    }
                }
                    
                nextOutput.txid = nextOutputTransaction.txid.substr(1)
                nextOutput.amount = nextOutput.value/SATOSHI_UNIT
                
                totalReceived = totalReceived + nextOutput.amount
            } else {
                throw new Error("There's no transaction for an output")
            }
            
            
            //Now let's find if there is an input in the database for this output.
            //If there is an input, then the output is spent (not an utxo)
            let nextOutputInput = null
            let nextOutputInputIsMempool = false
            //if REMOVE_SPENT is true, then there will be no inputs in the database, all stored outputs are utxos
            if (!REMOVE_SPENT){
                nextOutputInput = await this.db.getInput(nextOutput.txid, nextOutput.vout)
            }
            
            if (nextOutputInput == null){
                nextOutputInput = await this.mempoolDb.getInput(nextOutput.txid, nextOutput.vout)
                nextOutputInputIsMempool = true
            }
            
            if (nextOutputInput != null){
                if (!mempoolTransaction && nextOutputInputIsMempool){
                    confirmedBalance = confirmedBalance + nextOutput.amount
                    pendingBalance = pendingBalance - nextOutput.amount
                    utxosConfirmed = utxosConfirmed + 1
                }
                    
                outputs.splice(nextOutputIndex, 1)
                continue
            } else {
                if (mempoolTransaction){
                    pendingBalance = pendingBalance + nextOutput.amount
                    utxosPending = utxosPending + 1
                } else {
                    confirmedBalance = confirmedBalance + nextOutput.amount
                    utxosConfirmed = utxosConfirmed + 1
                }
            }
            
            nextOutputIndex = nextOutputIndex + 1
        }
        
        return {
            "address": address,
            "type": this.getAddressType(address, this.network),
            "balances": {
                "confirmed": confirmedBalance.toFixed(8),
                "pending": pendingBalance.toFixed(8),
                "received": totalReceived.toFixed(8)
            },
            "utxos": {
                "confirmed": utxosConfirmed,
                "pending": utxosPending
            }
        }
    }
    
    async getUtxosAddress(address){
        let script = bitcoin.address.toOutputScript(address, this.network)
        let scriptHash = createHash('sha256').update(script).digest('hex')
        
        let outputs = await this.db.getOutputsScriptPubKey(scriptHash)
        let mempoolOutputs = await this.mempoolDb.getOutputsScriptPubKey(scriptHash)
        
        outputs = outputs.concat(mempoolOutputs)
        
        let nextOutputIndex = 0
        while (nextOutputIndex < outputs.length){
            let mempoolTransaction = false
            let nextOutput = outputs[nextOutputIndex]
            
            let nextOutputTransactions = await this.db.getTransactions(nextOutput.txid) 
                
            if (nextOutputTransactions.length == 0){
                nextOutputTransactions = await this.mempoolDb.getTransactions(nextOutput.txid)  
                mempoolTransaction = true
            }
                
            if (nextOutputTransactions.length > 0){
                let nextOutputTransaction = nextOutputTransactions[0]
                let nextOutputBlock = await this.db.getBlock(nextOutputTransaction.block_hash)
                
                if (mempoolTransaction){
                    nextOutput.height = null
                    nextOutput.confirmations = 0
                } else {
                    if (nextOutputBlock != null){
                        nextOutput.height = nextOutputBlock.h
                        nextOutput.confirmations = this.blockchainInfoLastBlock - nextOutputBlock.h + 1
                    } else { //This means the block doesn't exists because it was removed by a reorg
                        outputs.splice(nextOutputIndex, 1)
                        continue
                    }
                }
                    
                nextOutput.txid = nextOutputTransaction.txid.substr(1)
                nextOutput.amount = nextOutput.value/SATOSHI_UNIT
                nextOutput.scriptPubKey = util.uint8ArrayToHex(script)
            } else {
                throw new Error("There's no transaction for an output")
            }
            
            
            //Now let's find if there is an input in the database for this output.
            //If there is an input, then the output is spent (not an utxo)
            let nextOutputInput = null
            
            //if REMOVE_SPENT is true, then there will be no inputs in the database, all stored outputs are utxos
            if (!REMOVE_SPENT){
                nextOutputInput = await this.db.getInput(nextOutput.txid, nextOutput.vout)
            }
            
            if (nextOutputInput == null){
                nextOutputInput = await this.mempoolDb.getInput(nextOutput.txid, nextOutput.vout)
            }
            
            if (nextOutputInput != null){
                outputs.splice(nextOutputIndex, 1)
                continue
            } 
            
            nextOutputIndex = nextOutputIndex + 1
        }
        
        return outputs
    }
    
    async getOldestTransaction(address){
        let script = bitcoin.address.toOutputScript(address, this.network)
        let scriptHash = createHash('sha256').update(script).digest('hex')
        
        let oldestOutput = null
        let outputs = null
            
        if (REMOVE_SPENT){
            let oldestOutputDb = await this.db.getOutputScriptBlock(scriptHash)
            outputs = [oldestOutputDb]
        } else {
            outputs = await this.db.getOutputsScriptPubKey(scriptHash)
        }
            
        let nextOutputIndex = 0
        while (nextOutputIndex < outputs.length){
            let nextOutput = outputs[nextOutputIndex]
            
            let nextOutputTransactions = await this.db.getTransactions(nextOutput.txid) 
                
            if (nextOutputTransactions.length > 0){
                let nextOutputTransaction = nextOutputTransactions[0]
                let nextOutputBlock = await this.db.getBlock(nextOutputTransaction.block_hash)
                
                    
                nextOutput.txid = nextOutputTransaction.txid.substr(1)
                nextOutput.height = nextOutputBlock.h
                nextOutput.confirmations = this.blockchainInfoLastBlock - nextOutputBlock.h + 1
                nextOutput.amount = nextOutput.value/SATOSHI_UNIT
                
                if ((oldestOutput == null) || (nextOutput.height < oldestOutput.height)){
                    oldestOutput = nextOutput
                }
                
                
            } else {
                throw new Error("There's no transaction for an output")
            }
            
            nextOutputIndex = nextOutputIndex + 1
        }
        
        return oldestOutput
    }
    
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
    
        await db.insertTransaction({hash:nextTxId, blockHash:blockHash})
        
        for (let txInputIndex=0;txInputIndex < transaction.ins.length;txInputIndex++){
            let nextInput = transaction.ins[txInputIndex]
            let standardInput = ("standard_input" in nextInput?nextInput["standard_input"]:true)
            
            if ((nextInput.index != 4294967295) && (standardInput)){//4294967295 = 0xFFFFFFFF. It's a Coinbase input, there's no need to trace it
                let outputTxHash = nextTxId
                
                if (removeSpent){
                    let prevTxHash8 = util.uint8ArrayToHex(nextInput.hash.reverse()).substring(0, 16)
                    await db.removeOutputWithInput({prevTxHash:prevTxHash8, prevOutputIndex:nextInput.index, blockHash:blockHash})
                } else {
                    await db.insertInput({
                        prevTxHash:util.uint8ArrayToHex(nextInput.hash.reverse()),
                        prevOutputIndex:nextInput.index,
                        txHash:nextTxId8
                    })
                }
                    
                if (addHints){
                    await db.insertInputHint({
                        prevTxHash:util.uint8ArrayToHex(nextInput.hash.reverse()), 
                        prevOutputIndex:nextInput.index, 
                        txHash:nextTxId8
                    })
                }
                
                resultInfo["inputsCount"] = resultInfo["inputsCount"] + 1
            }
        }
        for (let txOutputIndex=0;txOutputIndex < transaction.outs.length;txOutputIndex++){
            let nextOutput = transaction.outs[txOutputIndex]
            let outputValue = nextOutput.value
            let scriptHash = createHash('sha256').update(nextOutput.script).digest('hex')
            
            await db.insertOutput({scriptPubKey:scriptHash, txHash:nextTxId8, outputIndex:txOutputIndex, value:outputValue})

            if (addHints || removeSpent){
                await db.insertOutputHint({scriptPubKey:scriptHash, txHash:nextTxId8, outputIndex:txOutputIndex})
                await db.insertOutputScriptBlock(scriptHash, blockHash, nextTxId8, blockHeight)
            }
            resultInfo["outputsCount"] = resultInfo["outputsCount"] + 1
        }
        
        return resultInfo
    }
    
    async verifyReorg(){
        let thereAreDifferences = true
        let blocksDeleted = []
    
        while (thereAreDifferences){
            let lastBlockIndex = await this.db.getLastBlockHeight()
            let lastBlockHash = await this.db.getLastBlockHash()
            let lastBlock = await this.db.getBlock(lastBlockHash)
            
            if (lastBlockIndex != lastBlock["h"]){
                //This shouldn't happen, but let's try to find the real lastBlockIndex
                console.log("The blocks height for the same hash are not equal. Trying to fix the lastBlockIndex stored in db. This could take some minutes...")
                let lastBlockDb = await this.db.getLastBlock()
                
                if (lastBlockDb.height != lastBlock["h"]){
                    throw Error("There are inconsistents in a block height. It should be "+lastBlockIndex+" but "+lastBlock["h"]+" was found")
                } else {
                    await this.db.setLastBlockHash(lastBlockDb.hash)
                    await this.db.setLastBlockHeight(lastBlockDb.height)
                    console.log("Last block index was fixed!")
                    continue
                }
            } else {
                let blockHashFromNode
                try {
                    blockHashFromNode = await this.connector.getBlockHash(lastBlockIndex)
                } catch (err){
                    console.log("There was a problem trying to get a block hash from the node. Trying again...")
                    await this.sleep(3000)
                    continue
                }
                
                if (lastBlockHash != blockHashFromNode){
                    try {
                        if (REMOVE_SPENT){
                            await this.db.removeOutputScriptsInBlock(lastBlockHash)
                            await this.db.processDeletedOutputs(lastBlockHash, true)
                        }
                        await this.db.deleteBlock(lastBlockHash)
                        await this.removeFromLastBlocks(lastBlockHash)
                        await this.db.setLastBlockHash(lastBlock["ph"])
                        await this.db.setLastBlockHeight(lastBlock["h"]-1)
                        
                        console.log("Removed block "+lastBlockHash+" ("+lastBlock["h"]+")")
                        console.log("Rollback to previous block "+lastBlock["ph"]+" ("+(lastBlock["h"]-1)+")")
                        
                        blocksDeleted.push({"block_index":lastBlockIndex, "block_hash":lastBlockHash})
                    } catch (err){
                        console.log(err)
                        console.log("There was a problem trying to delete a block while verifying a reorg")
                    }
                } else {
                    thereAreDifferences = false
                }
            }
        }
        
        if (blocksDeleted.length > 0){
            console.log(blocksDeleted.length+" blocks were removed")
        }
        
        return true
    }
    
    
    async start(){
        this.db = new LevelUpStore(this.dbName)
        this.mempoolDb = new LevelUpStore("mempool"+this.dbName, true)
        await this.db.createDatabase()
        await this.mempoolDb.createDatabase()
        
        console.log("Indexing...")
        
        let lastProcessedBlockIndex = await this.db.getLastBlockHeight()
        let lastProcessedBlockHash = await this.db.getLastBlockHash()
        this.lastBlocks = await this.db.getLastStoredBlocks()
        let lastBlockchainInfo = null
        this.blockchainInfoLastBlock = -1
        let blocksQuantity = 0
        
        let startTimeStamp = Date.now()
        
        let blocksToInsert = []
        let transactionsToInsert = []
        let inputsToInsert = []
        let outputsToInsert = []
        
        let blocksCount = 0
        let transactionsCount = 0
        let inputsCount = 0
        let outputsCount = 0
        
        this.keepParsing = true
        this.parsingStopped = false
    
        while (true){
            if (this.keepParsing){
                //Getting the last block from the blockchain
                if (!lastBlockchainInfo || (lastProcessedBlockIndex >= this.blockchainInfoLastBlock)){
                    try {
                        lastBlockchainInfo = await this.connector.getBlockchainInfo()
                        
                        this.blockchainInfoLastBlock = lastBlockchainInfo["blocks"]
                    } catch (e){
                        console.log("Error trying to get network info from the node. Trying again...")
                        await this.sleep(3000)
                        continue
                    }
                    
                    if (lastProcessedBlockIndex > this.blockchainInfoLastBlock){
                        //This shouldn't happen, but let's try to find the real lastBlockIndex
                        console.log("The last processed block height are greater than the last block of the node. Trying to fix the lastBlockIndex stored in db. This could take some minutes...")
                        let lastBlockDb = await this.db.getLastBlock()
                        
                        if (lastBlockDb.height > this.blockchainInfoLastBlock){
                            console.log("WARNING! The last processed block height ("+lastBlockDb.height+") is greater than the last block from the network ("+this.blockchainInfoLastBlock+"). It's possible that the node was reset.")
                            //throw Error("The last processed block height ("+lastBlockDb.height+") is greater than the last block from the network ("+this.blockchainInfoLastBlock+")")
                        } else {
                            await this.db.setLastBlockHash(lastBlockDb.hash)
                            await this.db.setLastBlockHeight(lastBlockDb.height)
                            lastProcessedBlockIndex = lastBlockDb.height
                            lastProcessedBlockHash = lastBlockDb.hash
                            console.log("Last block index was fixed!")
                            continue
                        }
                    }
                }
                
                //If there is no new block, wait for some seconds to ask again
                if (lastProcessedBlockIndex == this.blockchainInfoLastBlock){
                    this.synced = true
                    if (this.mempoolInterval == null){
                        console.log("Mempool updates started!")
                        this.updateMempool()
                        this.mempoolInterval = setInterval(this.updateMempool.bind(this), MEMPOOL_INTERVAL)
                    }
                    
                    await this.sleep(CHECK_BLOCK_DELAY_MS)
                } else { //If there is a new block, parse it
                    //Put the flag synced false if there are too many blocks behind
                    if ((this.blockchainInfoLastBlock - lastProcessedBlockIndex) > SYNCED_THRESHOLD){
                        this.synced = false
                        if (this.mempoolInterval != null){
                            console.log("Mempool updates stopped!")
                            clearInterval(this.mempoolInterval)
                            this.mempoolInterval = null
                        }   
                    }
                    
                    //Get the next block
                    let nextBlockHeight = lastProcessedBlockIndex + 1
                
                    let nextBlockHash = null
                    let nextBlockHex = null             
                    try {
                        nextBlockHash = await this.connector.getBlockHash(nextBlockHeight)
                        
                        if (this.auxPow) {
                            nextBlockHex = await this.connector.getBlockWithoutAuxPow(nextBlockHash)
                        } else {
                            nextBlockHex = await this.connector.getBlock(nextBlockHash)
                        }
                    } catch (e){
                        console.log("Error trying to get next block from the node. Trying again...")
                        await this.sleep(3000)
                        continue
                    }
                    
                    var block = this.xchainBlockDecoder.blockFromHex(Buffer.from(nextBlockHex,"hex"))
                    let previousBlockHash = util.uint8ArrayToHex(block.prevHash.reverse())

                    //Check if there is a reorg
                    if (nextBlockHeight > 0){
                        //previousBlockHash is not the same, it must be a reorg 
                        if (previousBlockHash != lastProcessedBlockHash){
                            await this.db.endTransaction(false)
                            console.log("A reorg has been detected. Cleaning blocks...")
                            await this.verifyReorg()
                            lastProcessedBlockIndex = await this.db.getLastBlockHeight()
                            lastProcessedBlockHash = await this.db.getLastBlockHash()
                            
                            blocksQuantity = 0
                            blocksCount = 0
                            transactionsCount = 0
                            inputsCount = 0
                            outputsCount = 0
                            startTimeStamp = Date.now()
                            console.log("Blocks were updated")
                            continue
                        }
                    }
                    //Start a transaction if there are no blocks processed yet
                    if (blocksQuantity == 0){
                        await this.db.beginTransaction()
                    }
                    
                    //Insert the processed block
                    await this.db.insertBlock({hash:nextBlockHash, height:nextBlockHeight, timestamp:block.timestamp, previousHash:previousBlockHash})
                    blocksCount = blocksCount + 1               
                    
                    //Parse the transactions
                    var transactions = block.transactions

                    for (let txIndex=0;txIndex < transactions.length;txIndex++){
                        let nextTransaction = transactions[txIndex]
                        
                        let countInfo = await this.parseTransaction(this.db, nextTransaction, nextBlockHash, nextBlockHeight, false, REMOVE_SPENT)
                        
                        transactionsCount = transactionsCount + 1
                        inputsCount = inputsCount + countInfo["inputsCount"]
                        outputsCount = outputsCount + countInfo["outputsCount"]
                    }
                    
                    //Add the block to the last blocks
                    await this.addToLastBlocks(nextBlockHash)
                    
                    //If there are enough processed blocks, then add them to the database
                    if ((blocksQuantity == DB_TRANSACTION_BLOCKS_QUANTITY-1) || (nextBlockHeight == this.blockchainInfoLastBlock)){
                        console.log("Indexing block "+(nextBlockHeight)+"("+nextBlockHash+")")
                        await this.db.setLastBlockHeight(nextBlockHeight)
                        await this.db.setLastBlockHash(nextBlockHash)
                        console.log("Inserting data Blocks ("+blocksCount+") Transactions ("+transactionsCount+") Inputs ("+inputsCount+") Outputs("+outputsCount+")")
                        
                        await this.db.endTransaction()
                        
                        blocksCount = 0
                        transactionsCount = 0
                        inputsCount = 0
                        outputsCount = 0
                        
                        let endTimeStamp = Date.now()
                        
                        let msPerBlock = ((endTimeStamp - startTimeStamp)/DB_TRANSACTION_BLOCKS_QUANTITY)
                        startTimeStamp = Date.now()
                        
                        let msLeft = (this.blockchainInfoLastBlock - nextBlockHeight)*msPerBlock
                        
                        if (msLeft > 0){
                            let msLeftFormatted = this.millisecondsToTimeString(msLeft)
                            console.log("Estimated time to finish: "+msLeftFormatted)
                        }
                        
                        blocksQuantity = -1
                    }
                    
                    blocksQuantity = blocksQuantity + 1
                    lastProcessedBlockIndex = nextBlockHeight
                    lastProcessedBlockHash = nextBlockHash
                }
            } else {
                console.log("Stopping the parsing...")
                await this.db.close()
                this.parsingStopped = true
                break
            }
        }
    }
    
    async updateMempool(){
        if (!this.mempoolBusy){
            let mempoolStartTime = Date.now()
            this.mempoolBusy = true
            let rawMempool = []
            try {
                let rawMempoolUnordered = await this.connector.getRawMempool()
                
                for (let nextUnorderedItemIndex in rawMempoolUnordered){
                    let nextUnorderedItem = rawMempoolUnordered[nextUnorderedItemIndex]
                    
                    let newIndex = bs(rawMempool, nextUnorderedItem, function(element, needle) { return needle.localeCompare(element) })
                    
                    if (newIndex < 0){
                        rawMempool.splice(-newIndex-1, 0, nextUnorderedItem)
                    }
                }
                
                
                
            } catch (error){
                console.log("There were problems getting the mempool, trying again later.")
                return
            }
            
            let transactionsCount = 0
            let inputsCount = 0
            let outputsCount = 0
            
            
            await this.mempoolDb.beginTransaction()
            //This deletes the txs that are in the database but not longer in the mempool. Also, it removes
            //the transactions that already exist in the database, leaving rawMempool only with the new transactions from the mempool
            let deletedInfo = await this.mempoolDb.deleteAndCompareTxsNotInList(rawMempool) 
            
            let deletedTransactionsCount = deletedInfo.transactionsDeleted
            let deletedInputsCount = deletedInfo.inputsDeleted
            let deletedOutputsCount = deletedInfo.outputsDeleted
            
            let i = 0
            while(i<rawMempool.length){
                let nextRawMempoolChunk = rawMempool.slice(i, i+MEMPOOL_BATCH_SIZE)
                
                let nextTxsHex = []
                try {
                    nextTxsHex = await this.connector.getRawTransactions(nextRawMempoolChunk)
                    
                } catch (err){
                    console.log(err)
                    console.log("There was an error trying to get raw transactions from the mempool. Trying again...")
                    await this.sleep(1000)
                    continue
                }
                
                for (let nextTxHexIndex in nextTxsHex){
                    let nextTxHex = nextTxsHex[nextTxHexIndex]
                    
                    if (nextTxHex != null){
                        let nextTx = this.xchainBlockDecoder.txFromHex(nextTxHex)

                        let countInfo = await this.parseTransaction(this.mempoolDb, nextTx, null, -1, true)
                        
                        if (transactionsCount % MEMPOOL_BATCH_SIZE == 0){
                            console.log(""+transactionsCount+" parsed txs of "+rawMempool.length)
                        }
                        
                        transactionsCount = transactionsCount + 1
                        inputsCount = inputsCount + countInfo["inputsCount"]
                        outputsCount = outputsCount + countInfo["outputsCount"]
                    }
                }
                    
                i = i + MEMPOOL_BATCH_SIZE
                await this.sleep(10000)
            }
            
            await this.mempoolDb.endTransaction()
            this.mempoolBusy = false
            let mempoolEndTime = Date.now()
            let timeString = this.millisecondsToTimeString(mempoolEndTime-mempoolStartTime)
            
            console.log("Mempool updated!"
                +" Transactions ("+transactionsCount+" more, "+deletedTransactionsCount+" less)"
                +" Inputs ("+inputsCount+" more, "+deletedInputsCount+" less) "
                +" Outputs("+outputsCount+" more, "+deletedOutputsCount+" less) ["+timeString+"]")
        } else {
            console.log("Mempool is still busy")
        }
    }
    
}

module.exports = XChainUtxoTracker