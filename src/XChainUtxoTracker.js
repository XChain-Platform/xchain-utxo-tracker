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
const DB_TRANSACTION_BLOCKS_QUANTITY = 200
const PARSE_MODE_FILES = 0
const PARSE_MODE_BULK_INSERTS = 1
const SYNCED_THRESHOLD = 3
const SATOSHI_UNIT = 100000000.0
const MEMPOOL_INTERVAL = 60000
const MEMPOOL_BATCH_SIZE = 1000
const REMOVE_SPENT = true
const ETA_WINDOW_BLOCKS = 1000 //Rolling window size for ETA calculation
const MIN_VERIFICATION_PROGRESS_TO_PARSE = 0.99 //How much progress the node need to have to start parsing

const UNDO_BLOCKS = 10 //This is the number of blocks from which the outputs will be kept saved.
const PREFETCH_SIZE = 10 //Number of blocks to pre-fetch concurrently while processing the current one

class XChainUtxoTracker {
    static parseOutBuckets = { hash: 0, ins: 0, sb: 0 }

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
      this.pendingKMCleanup = []
    }
    
    async addToLastBlocks(blockHash){
        this.lastBlocks.push(blockHash)
        this.db.addLastStoredBlock(blockHash)

        while (this.lastBlocks.length > UNDO_BLOCKS){
            let nextBlockHash = this.lastBlocks.shift()

            // Discard in-memory deletions for outputs created & spent within the same batch.
            // On-disk K/M cleanup is deferred to after the batch is committed via cleanupAgedBlocks().
            if (this.db.deletedTransactionArray && this.db.deletedTransactionArray.has(nextBlockHash)){
                this.db.deletedTransactionArray.delete(nextBlockHash)
            }

            this.pendingKMCleanup.push(nextBlockHash)
        }
    }

    async cleanupAgedBlocks(){
        // Called after endTransaction() so K/M entries are committed to disk and can be found
        if (this.pendingKMCleanup.length === 0) return

        await this.db.beginTransaction()

        for (let blockHash of this.pendingKMCleanup){
            await this.db.processDeletedOutputs(blockHash, false)
            await this.db.removeLastStoredBlock(blockHash)
        }

        await this.db.endTransaction()
        this.pendingKMCleanup = []
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
        hours = Math.floor((ms / (1000 * 60 * 60)) % 24),
        days = Math.floor(ms / (1000 * 60 * 60 * 24));

        hours = (hours < 10) ? "0" + hours : hours;
        minutes = (minutes < 10) ? "0" + minutes : minutes;
        seconds = (seconds < 10) ? "0" + seconds : seconds;

        let result = hours + "h" + minutes + "m" + seconds + "." + milliseconds+"s";
        if (days > 0) result = days + "d " + result;
        return result;
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

        let confirmedOutputs = await this.db.getOutputsScriptPubKey(scriptHash)
        let mempoolOutputs = await this.mempoolDb.getOutputsScriptPubKey(scriptHash)

        for (let nextOutput of confirmedOutputs) {
            let txid = nextOutput.fullTxid || nextOutput.txid
            let amount = nextOutput.value / SATOSHI_UNIT

            // Note: with REMOVE_SPENT=true, totalReceived only reflects currently unspent confirmed outputs
            totalReceived += amount

            let mempoolInput = await this.mempoolDb.getInput(txid, nextOutput.vout)
            if (mempoolInput != null) {
                // Confirmed output being spent in the mempool: counts as confirmed but pending out
                confirmedBalance += amount
                pendingBalance -= amount
                utxosConfirmed++
            } else {
                confirmedBalance += amount
                utxosConfirmed++
            }
        }

        for (let nextOutput of mempoolOutputs) {
            let txid = nextOutput.fullTxid || nextOutput.txid

            let mempoolInput = await this.mempoolDb.getInput(txid, nextOutput.vout)
            if (mempoolInput == null) {
                pendingBalance += nextOutput.value / SATOSHI_UNIT
                utxosPending++
            }
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
        let scriptPubKeyHex = util.uint8ArrayToHex(script)

        let confirmedOutputs = await this.db.getOutputsScriptPubKey(scriptHash)
        let mempoolOutputs = await this.mempoolDb.getOutputsScriptPubKey(scriptHash)

        let results = []

        for (let nextOutput of confirmedOutputs) {
            let txid = nextOutput.fullTxid || nextOutput.txid

            // Skip confirmed outputs being spent in the mempool
            let mempoolInput = await this.mempoolDb.getInput(txid, nextOutput.vout)
            if (mempoolInput != null) continue

            nextOutput.txid = txid
            nextOutput.confirmations = this.blockchainInfoLastBlock - nextOutput.height + 1
            nextOutput.amount = nextOutput.value / SATOSHI_UNIT
            nextOutput.scriptPubKey = scriptPubKeyHex
            results.push(nextOutput)
        }

        for (let nextOutput of mempoolOutputs) {
            let txid = nextOutput.fullTxid || nextOutput.txid

            // Skip mempool outputs that are also spent by another mempool tx
            let mempoolInput = await this.mempoolDb.getInput(txid, nextOutput.vout)
            if (mempoolInput != null) continue

            nextOutput.txid = txid
            nextOutput.height = null
            nextOutput.confirmations = 0
            nextOutput.amount = nextOutput.value / SATOSHI_UNIT
            nextOutput.scriptPubKey = scriptPubKeyHex
            results.push(nextOutput)
        }

        return results
    }
    
    async getFirstSeen(address){
        const script = bitcoin.address.toOutputScript(address, this.network)
        const scriptHash = createHash('sha256').update(script).digest('hex')

        const record = await this.db.getOutputScriptBlock(scriptHash)
        if (!record) return null

        return { height: record.h }
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
    
        if (!removeSpent) {
            await db.insertTransaction({hash:nextTxId, blockHash:blockHash})
        }

        // Process all inputs concurrently — each input has its own hash buffer so
        // the in-place .reverse() calls don't interfere between parallel closures
        const inputCounts = await Promise.all(transaction.ins.map(async (nextInput) => {
            const standardInput = ("standard_input" in nextInput ? nextInput["standard_input"] : true)

            if ((nextInput.index === 4294967295) || !standardInput) { //4294967295 = 0xFFFFFFFF. It's a Coinbase input, there's no need to trace it
                return 0
            }

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

            return 1
        }))

        // Process all outputs concurrently — each output is fully independent
        await Promise.all(transaction.outs.map(async (nextOutput, txOutputIndex) => {
            const scriptHash = createHash('sha256').update(nextOutput.script).digest('hex')

            await db.insertOutput({scriptPubKey:scriptHash, txHash:nextTxId8, outputIndex:txOutputIndex, value:nextOutput.value, height:blockHeight, fullTxHash:nextTxId})

            if (addHints || removeSpent){
                await db.insertOutputHint({scriptPubKey:scriptHash, txHash:nextTxId8, outputIndex:txOutputIndex})
                await db.insertOutputScriptBlock(scriptHash, blockHash, blockHeight)
            }
        }))

        resultInfo["inputsCount"]  = inputCounts.reduce((acc, n) => acc + n, 0)
        resultInfo["outputsCount"] = transaction.outs.length

        return resultInfo
    }
    
    // Pass 1 of two-pass block processing: insert all outputs (and the tx record).
    // Must complete for ALL transactions before parseTxInputs runs, so that
    // removeOutputWithInput can find same-block outputs in transactionArray.
    async parseTxOutputs(db, transaction, blockHash, blockHeight, addHints, removeSpent){
        const nextTxId  = "id" in transaction ? transaction["id"] : transaction.getId()
        const nextTxId8 = nextTxId.substring(0, 16)
        const _tt = XChainUtxoTracker.parseOutBuckets

        if (!removeSpent) {
            await db.insertTransaction({hash: nextTxId, blockHash: blockHash})
        }

        // Sequential in vout order so that insertOutputScriptBlock writes the
        // S-record for the first (smallest vout) occurrence of a scriptHash —
        // matching bulk-sync's block-tx-vout-ordered dedup. Concurrent Promise.all
        // here raced, producing non-deterministic S-record winners.
        for (let txOutputIndex = 0; txOutputIndex < transaction.outs.length; txOutputIndex++) {
            const nextOutput = transaction.outs[txOutputIndex]
            const _h0 = Date.now()
            // Keep the hash as a Buffer — insertOutput / insertOutputHint /
            // insertOutputScriptBlock all accept Buffers and use buf.copy()
            // instead of decoding a hex string back into bytes.
            const scriptHash = createHash('sha256').update(nextOutput.script).digest()
            _tt.hash += Date.now() - _h0

            const _i0 = Date.now()
            await db.insertOutput({scriptPubKey: scriptHash, txHash: nextTxId8, outputIndex: txOutputIndex, value: nextOutput.value, height: blockHeight, fullTxHash: nextTxId})
            _tt.ins += Date.now() - _i0

            if (addHints || removeSpent) {
                const _i1 = Date.now()
                await db.insertOutputHint({scriptPubKey: scriptHash, txHash: nextTxId8, outputIndex: txOutputIndex})
                _tt.ins += Date.now() - _i1

                const _s0 = Date.now()
                await db.insertOutputScriptBlock(scriptHash, blockHash, blockHeight)
                _tt.sb += Date.now() - _s0
            }
        }

        return transaction.outs.length
    }

    // Pass 2 of two-pass block processing: process all inputs.
    // By the time this runs, all same-block outputs are already in transactionArray,
    // so removeOutputWithInput will resolve intra-block spends correctly.
    async parseTxInputs(db, transaction, blockHash, addHints, removeSpent){
        const nextTxId  = "id" in transaction ? transaction["id"] : transaction.getId()
        const nextTxId8 = nextTxId.substring(0, 16)

        const inputCounts = await Promise.all(transaction.ins.map(async (nextInput) => {
            const standardInput = ("standard_input" in nextInput ? nextInput["standard_input"] : true)

            if ((nextInput.index === 4294967295) || !standardInput) { //4294967295 = 0xFFFFFFFF. It's a Coinbase input, there's no need to trace it
                return 0
            }

            if (removeSpent) {
                const prevTxHash8 = util.uint8ArrayToHex(nextInput.hash.reverse()).substring(0, 16)
                await db.removeOutputWithInput({prevTxHash: prevTxHash8, prevOutputIndex: nextInput.index, blockHash: blockHash})
            } else {
                await db.insertInput({
                    prevTxHash: util.uint8ArrayToHex(nextInput.hash.reverse()),
                    prevOutputIndex: nextInput.index,
                    txHash: nextTxId8
                })
            }

            if (addHints) {
                await db.insertInputHint({
                    prevTxHash: util.uint8ArrayToHex(nextInput.hash.reverse()),
                    prevOutputIndex: nextInput.index,
                    txHash: nextTxId8
                })
            }

            return 1
        }))

        return inputCounts.reduce((acc, n) => acc + n, 0)
    }

    async verifyReorg(){
        let thereAreDifferences = true
        let blocksDeleted = []
    
        while (thereAreDifferences){
            let lastBlockIndex = await this.db.getLastBlockHeight()
            let lastBlockHash = await this.db.getLastBlockHash()
            let lastBlock = await this.db.getBlock(lastBlockHash)
            
            console.log("Last block index is "+lastBlockIndex)
            console.log("Last block hash is "+lastBlockHash)
            console.log("Last block height is "+(lastBlock?lastBlock["h"]:"null"))
            
            if (!lastBlock || (lastBlockIndex != lastBlock["h"])){
                //This shouldn't happen, but let's try to find the real lastBlockIndex
                console.log("The blocks height for the same hash are not equal. Trying to fix the lastBlockIndex stored in db. This could take some minutes...")
                let lastBlockDb = await this.db.getLastBlock()
                console.log("Last block from db is "+(lastBlockDb?lastBlockDb:"null"))
                
                if (lastBlock && (lastBlockDb.height != lastBlock["h"])){
                    throw Error("There are inconsistents in a block height. It should be "+lastBlockIndex+" but "+lastBlock["h"]+" was found")
                } else {
                    await this.db.setLastBlockHash(lastBlockDb.hash)
                    await this.db.setLastBlockHeight(lastBlockDb.height)
                    console.log("The new last block hash in the db is "+lastBlockDb.hash)
                    console.log("The new last block index in the db is "+lastBlockDb.height)
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
                
                console.log("Last block hash from node is "+blockHashFromNode)
                
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
        
        let blockTimestamps = [] // Rolling window of {height, time, txCount} for ETA calculation
        let _t = { fetch: 0, decode: 0, parse: 0, parseOut: 0, parseIn: 0, commit: 0, cleanup: 0, blocks: 0 }
        let pendingCommit = null

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

        // Prefetch queue: each entry is { height, promise } where promise resolves to { hash, hex }
        let prefetchQueue = []

        const fetchBlock = async (height) => {
            const hash = await this.connector.getBlockHash(height)
            const hex = this.auxPow
                ? await this.connector.getBlockWithoutAuxPow(hash)
                : await this.connector.getBlock(hash)
            return { hash, hex }
        }

        const fillPrefetchQueue = (fromHeight, tipHeight) => {
            let maxQueued = fromHeight - 1
            if (prefetchQueue.length > 0) {
                maxQueued = prefetchQueue[prefetchQueue.length - 1].height
            }

            // Collect all heights that still need to be queued
            const heights = []
            while (prefetchQueue.length + heights.length < PREFETCH_SIZE && maxQueued + 1 <= tipHeight) {
                maxQueued++
                heights.push(maxQueued)
            }
            if (heights.length === 0) return

            if (this.auxPow) {
                // AuxPoW requires custom header stripping — fetch individually
                heights.forEach(h => {
                    const p = fetchBlock(h)
                    p.catch(() => {}) // suppress unhandled rejection if entry is cleared from queue before being awaited
                    prefetchQueue.push({ height: h, promise: p })
                })
            } else {
                // Non-AuxPoW: one batch HTTP request for all getblockhash + one for all getblock
                const batchPromise = this.connector.getBlocksBatch(heights)
                heights.forEach((h, i) => {
                    const p = batchPromise.then(results => ({ hash: results[i].hash, hex: results[i].hex }))
                    p.catch(() => {}) // suppress unhandled rejection if entry is cleared from queue before being awaited
                    prefetchQueue.push({ height: h, promise: p })
                })
            }
        }

        let nodeSyncedProblem = false
    
        while (true){
            if (this.keepParsing){
                //Getting the last block from the blockchain
                if (!lastBlockchainInfo || (lastProcessedBlockIndex >= this.blockchainInfoLastBlock)){
                    try {
                        lastBlockchainInfo = await this.connector.getBlockchainInfo()
                        
                        if (lastBlockchainInfo["verificationprogress"] < MIN_VERIFICATION_PROGRESS_TO_PARSE){
                            if (!nodeSyncedProblem){
                                console.log("The node is not synced. Waiting for it to synchronize...")
                            }
                            
                            lastBlockchainInfo = null
                            nodeSyncedProblem = true
                            await this.sleep(3000)
                            continue
                        } else {
                            nodeSyncedProblem = false
                        }
                        
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

                    // Kick off pre-fetches for upcoming blocks while we process the current one
                    fillPrefetchQueue(nextBlockHeight, this.blockchainInfoLastBlock)

                    let nextBlockHash = null
                    let nextBlockHex = null
                    try {
                        let fetched
                        if (prefetchQueue.length > 0 && prefetchQueue[0].height === nextBlockHeight) {
                            fetched = await prefetchQueue.shift().promise
                        } else {
                            // Queue is out of sync (e.g. after reorg) — fetch directly
                            prefetchQueue = []
                            fetched = await fetchBlock(nextBlockHeight)
                        }
                        nextBlockHash = fetched.hash
                        nextBlockHex = fetched.hex
                    } catch (e){
                        prefetchQueue = []
                        console.log("Error trying to get next block from the node. Trying again...")
                        await this.sleep(3000)
                        continue
                    }
                    
                    const _tDecode = Date.now()
                    var block = this.xchainBlockDecoder.blockFromHex(nextBlockHex)
                    let previousBlockHash = util.uint8ArrayToHex(block.prevHash.reverse())
                    _t.decode += Date.now() - _tDecode

                    //Check if there is a reorg
                    if (nextBlockHeight > 0){
                        //previousBlockHash is not the same, it must be a reorg 
                        if (previousBlockHash != lastProcessedBlockHash){
                            prefetchQueue = []
                            await this.db.endTransaction(false)
                            this.lastBlocks = await this.db.getLastStoredBlocks()
                            console.log("A reorg has been detected. Cleaning blocks...")
                            await this.verifyReorg()
                            lastProcessedBlockIndex = await this.db.getLastBlockHeight()
                            lastProcessedBlockHash = await this.db.getLastBlockHash()

                            blocksQuantity = 0
                            blocksCount = 0
                            transactionsCount = 0
                            inputsCount = 0
                            outputsCount = 0
                            this.pendingKMCleanup = []
                            blockTimestamps = []
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
                    
                    //Parse the transactions — two-pass approach to allow full parallelism:
                    //  Pass 1: insert all outputs for every tx concurrently
                    //  Pass 2: process all inputs concurrently (same-block outputs are
                    //          now in transactionArray so removeOutputWithInput finds them)
                    var transactions = block.transactions

                    const _tParse = Date.now()
                    const _tParseOut = Date.now()
                    // Sequential in tx-index order so that S-record writes across
                    // txs in the same block land in deterministic (tx-index, vout)
                    // order — matching bulk-sync.
                    const blockOutputCounts = new Array(transactions.length)
                    for (let txIdx = 0; txIdx < transactions.length; txIdx++) {
                        blockOutputCounts[txIdx] = await this.parseTxOutputs(
                            this.db, transactions[txIdx], nextBlockHash, nextBlockHeight, false, REMOVE_SPENT
                        )
                    }
                    _t.parseOut += Date.now() - _tParseOut
                    // Pass 2: collect all inputs across the block, then batch-remove
                    const _tParseIn = Date.now()
                    const removeInputs = []
                    for (const tx of transactions) {
                        for (const nextInput of tx.ins) {
                            const standardInput = ("standard_input" in nextInput ? nextInput["standard_input"] : true)
                            if ((nextInput.index === 4294967295) || !standardInput) continue
                            const prevTxHash8 = util.uint8ArrayToHex(nextInput.hash.reverse()).substring(0, 16)
                            removeInputs.push({ prevTxHash: prevTxHash8, prevOutputIndex: nextInput.index, blockHash: nextBlockHash })
                        }
                    }
                    let blockInputTotal = removeInputs.length
                    if (removeInputs.length > 0) {
                        await this.db.removeOutputsWithInputsBatch(removeInputs)
                    }
                    _t.parseIn += Date.now() - _tParseIn
                    _t.parse += Date.now() - _tParse

                    transactionsCount = transactionsCount + transactions.length
                    outputsCount = outputsCount + blockOutputCounts.reduce((acc, n) => acc + n, 0)
                    inputsCount  = inputsCount  + blockInputTotal

                    // Eagerly remove mempool-DB entries for txs that have now
                    // been confirmed in this block. Without this, the mempool
                    // DB can hold stale records for up to MEMPOOL_INTERVAL (60s)
                    // after a tx is mined — get_utxos would return those stale
                    // outputs alongside the confirmed ones, the encoder would
                    // sort by value and pick the (now-spent) stale UTXO as the
                    // first input, and the broadcast would fail with
                    // node error -25 "Missing inputs". The block-time cleanup
                    // is a no-op for txs the mempool poll never saw (most of
                    // them in regtest, where blocks mine faster than the 60s
                    // mempool refresh tick).
                    for (const tx of transactions) {
                        const txid = "id" in tx ? tx["id"] : tx.getId()
                        await this.mempoolDb.deleteOutputsByHint(txid)
                        await this.mempoolDb.deleteInputsByHint(txid)
                        await this.mempoolDb.deleteTransaction(txid)
                    }

                    //Add the block to the last blocks
                    await this.addToLastBlocks(nextBlockHash)
                    
                    //If there are enough processed blocks, then add them to the database
                    if ((blocksQuantity == DB_TRANSACTION_BLOCKS_QUANTITY-1) || (nextBlockHeight == this.blockchainInfoLastBlock)){
                        console.log("Indexing block "+(nextBlockHeight)+"("+nextBlockHash+")")
                        await this.db.setLastBlockHeight(nextBlockHeight)
                        await this.db.setLastBlockHash(nextBlockHash)
                        console.log("Inserting data Blocks ("+blocksCount+") Transactions ("+transactionsCount+") Inputs ("+inputsCount+") Outputs("+outputsCount+")")

                        const _tCommit = Date.now()
                        await this.db.endTransaction()
                        _t.commit += Date.now() - _tCommit

                        // Clean up K/M entries for aged-out blocks now that the batch is committed
                        const _tCleanup = Date.now()
                        await this.cleanupAgedBlocks()
                        _t.cleanup += Date.now() - _tCleanup

                        // ── Print timing summary ──
                        _t.blocks = blocksQuantity + 1
                        const _total = _t.decode + _t.parse + _t.commit + _t.cleanup
                        const _pb = XChainUtxoTracker.parseOutBuckets
                        const _pi = LevelUpStore.parseInBuckets
                        const _ks = LevelUpStore.knownScripts
                        const _ksH = LevelUpStore.knownScriptsHits
                        const _ksM = LevelUpStore.knownScriptsMisses
                        const _ksRate = _ksH + _ksM > 0 ? ((_ksH / (_ksH + _ksM)) * 100).toFixed(1) : '0.0'
                        const _mem = process.memoryUsage()
                        const _heapMB = (_mem.heapUsed / 1048576).toFixed(0)
                        const _rssMB = (_mem.rss / 1048576).toFixed(0)
                        const _ocSize = LevelUpStore.outputCache.size
                        console.log(`⏱ TIMING (${_t.blocks} blocks) total=${_total}ms | decode=${_t.decode}ms | parse=${_t.parse}ms (out=${_t.parseOut}ms [hash=${_pb.hash}ms ins=${_pb.ins}ms sb=${_pb.sb}ms] in=${_t.parseIn}ms [hintRead=${_pi.hintRead}ms outRead=${_pi.outRead}ms stage=${_pi.stage}ms]) | commit=${_t.commit}ms | cleanup=${_t.cleanup}ms | knownScripts=${_ks.size} hit=${_ksH} miss=${_ksM} rate=${_ksRate}% | heap=${_heapMB}MB rss=${_rssMB}MB outCache=${_ocSize}`)
                        XChainUtxoTracker.parseOutBuckets = { hash: 0, ins: 0, sb: 0 }
                        LevelUpStore.parseInBuckets = { hintRead: 0, outRead: 0, stage: 0 }
                        LevelUpStore.knownScriptsHits = 0
                        LevelUpStore.knownScriptsMisses = 0

                        // Rolling ETA based on tx throughput — window is a span of
                        // ETA_WINDOW_BLOCKS blocks, not a count of samples. Each sample
                        // covers DB_TRANSACTION_BLOCKS_QUANTITY blocks, so a count-based
                        // trim would keep ~200× more history than intended.
                        blockTimestamps.push({height: nextBlockHeight, time: Date.now(), txCount: transactionsCount})
                        while (blockTimestamps.length >= 2 &&
                               (nextBlockHeight - blockTimestamps[0].height) > ETA_WINDOW_BLOCKS) {
                            blockTimestamps.shift()
                        }

                        _t = { fetch: 0, decode: 0, parse: 0, parseOut: 0, parseIn: 0, commit: 0, cleanup: 0, blocks: 0 }
                        blocksCount = 0
                        transactionsCount = 0
                        inputsCount = 0
                        outputsCount = 0

                        let blocksLeft = this.blockchainInfoLastBlock - nextBlockHeight
                        if (blocksLeft > 0 && blockTimestamps.length >= 2) {
                            let oldest = blockTimestamps[0]
                            let newest = blockTimestamps[blockTimestamps.length - 1]
                            let totalTx = 0
                            for (let k = 1; k < blockTimestamps.length; k++) totalTx += blockTimestamps[k].txCount
                            let elapsedMs = newest.time - oldest.time
                            let msPerTx = elapsedMs / totalTx
                            let avgTxPerBlock = totalTx / (newest.height - oldest.height)
                            let msLeft = blocksLeft * avgTxPerBlock * msPerTx
                            console.log(`⚡ Speed: ${(1000/msPerTx).toFixed(1)} tx/s | avg ${avgTxPerBlock.toFixed(0)} tx/block (last ${newest.height - oldest.height} blocks)`)
                            console.log("Estimated time to finish: "+this.millisecondsToTimeString(msLeft))
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

                    // binary-search convention: comparator(element, needle)
                    // returns negative when element < needle (search right).
                    // Pairs with deleteAndCompareTxsNotInList downstream, which
                    // uses the same convention after the fix in commit 095bee7;
                    // both must use the SAME polarity for the sorted list to
                    // round-trip correctly.
                    let newIndex = bs(rawMempool, nextUnorderedItem, function(element, needle) { return element.localeCompare(needle) })

                    if (newIndex < 0){
                        rawMempool.splice(-newIndex-1, 0, nextUnorderedItem)
                    }
                }
                
                
                
            } catch (error){
                console.log("There were problems getting the mempool, trying again later.")
                // Reset the busy flag — without this, a single transient
                // getRawMempool failure permanently locks out further mempool
                // updates for the lifetime of the process (next setInterval
                // tick sees mempoolBusy=true and bails).
                this.mempoolBusy = false
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
                // Only throttle between batches — the inter-batch sleep is for
                // CPU/IO breathing room when a giant mempool needs many passes.
                // If we just finished the final batch (or only batch), don't
                // sleep — single-batch updates (typical for regtest and most
                // mainnet conditions) shouldn't pay a 10s tail latency.
                if (i < rawMempool.length) {
                    await this.sleep(10000)
                }
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