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
 * XChain UTXO Tracker - FileManager Class
 * 
 * This file handles reading and writing UTXO tracker data to LevelDB database
 *
 ********************************************************************/

// Load required libraries
const util = require('./util')

var levelup = require('levelup')
var leveldown = require('leveldown')
var memdown = require('memdown')
const encode = require('encoding-down')
const bs = require("binary-search")

const PREFIX_LAST_BLOCK_HEIGHT = "LAST_BLOCK_HEIGHT"
const PREFIX_LAST_BLOCK_HASH = "LAST_BLOCK_HASH"
const PREFIX_BLOCK = "B"
const PREFIX_TRANSACTION = "T"
const PREFIX_INPUT = "I"
const PREFIX_OUTPUT = "O"
const PREFIX_OUTPUT_HINT = "H"
const PREFIX_INPUT_HINT = "J"
const PREFIX_OUTPUT_SCRIPT_BLOCK = "S"
const PREFIX_BLOCK_OUTPUT_SCRIPT = "Z"

const PREFIX_OUTPUT_DELETED = "K"
const PREFIX_OUTPUT_HINT_DELETED = "M"

const PREFIX_STORED_BLOCK = "N" //These are the blocks whose outputs will be stored instead of being deleted

class LevelUpStore {
    constructor(dbName, inMemory = false) {
        this.dbName = dbName
        this.db = null
        this.transactionArray = new Map()
        this.deletedTransactionArray = new Map()
        this.inMemory = inMemory
    }
  
    async sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    
    async close(){
        await this.db.close()
    }
  
    async createDatabase() {
        try {
            if (this.inMemory){
                this.db = levelup(memdown())
            } else {
                this.db = levelup(leveldown("/data/"+this.dbName))  
            }
        
            return this.db
        } catch (err){
            throw new Error("Couldn't open/create levelup database")
        }
    }

    elementCompare(a,b){
        return (a < b ? -1: (a > b ? 1 : 0))
    }

    getTransactionValue(key){
        const item = this.transactionArray.get(key)
        return item != null ? item.value : null
    }

    async addTransaction(type, key, value=null){
        let newItem = {
            type:type,
            key: key,
            value: value        
        }
        
        if (this.transactionArray != null){
            this.transactionArray.set(key, newItem)
            return true
        } else {
            switch(type){
                case "put":
                    await this.db.put(key, value)
                    break
                case "del":
                    await this.db.del(key)
                    break
                default:
                    throw new Error("Unknown db transaction type: "+type)
            }
            
            return true
        }
    }
  
    removeTransactionIfExists(key){
        if (this.transactionArray && this.transactionArray.has(key)){
            return this.transactionArray.delete(key)
        }
        
        return false
    }
  
    removeTransaction(key, deletedKey){
        if (!this.deletedTransactionArray.has(deletedKey)){
            this.deletedTransactionArray.set(deletedKey, new Map())
        }
    
        this.deletedTransactionArray.get(deletedKey).set(key, this.transactionArray.get(key).value)
    
        return this.transactionArray.delete(key)
    }

    async beginTransaction(){
        this.transactionArray = new Map()
        this.deletedTransactionArray = new Map()
    }

    async endTransaction(batch=true){
        try {
            if (batch){
                let transactionArrayFromMap = Array.from(this.transactionArray.values())
                await this.db.batch(transactionArrayFromMap)
            }
            
            this.transactionArray = null
            this.deletedTransactionArray = null
        } catch (err){
            console.log("There were errors trying to insert data in a batch")
            console.log(err)
            throw new Error("Error in levelup batch inserting")
        }
    }

    async getLastBlockHeight(){
        try {
            let value = await this.db.get(PREFIX_LAST_BLOCK_HEIGHT)
            let height = parseInt(value.toString(), 16);
            return height
        } catch (err) {
            return -1
        }
    }

    async setLastBlockHeight(height){
        let key = PREFIX_LAST_BLOCK_HEIGHT
      
        //if (this.transactionArray != null){
            await this.addTransaction("put", key, height.toString(16))
            return true
        //} else {
        //    return await this.db.put(key, height.toString(16))
        //}
    }

    async getLastBlockHash(){
        try {
            let value = await this.db.get(PREFIX_LAST_BLOCK_HASH)
            let hash = value.toString();
            return hash
        } catch (err) {
            return null
        }
    }

    async setLastBlockHash(hash){
        let key = PREFIX_LAST_BLOCK_HASH
      
        return await this.addTransaction("put", key, hash)
    }

    async addLastStoredBlock(blockHash){
        let key = PREFIX_STORED_BLOCK + blockHash
        
        return await this.addTransaction("put", key, "")
    }

    async removeLastStoredBlock(blockHash){
        let key = PREFIX_STORED_BLOCK + blockHash
        
        if (this.removeTransactionIfExists(key)){
            return true
        } else {
            try{
                await this.addTransaction("del", key)
                return true
            } catch (err) {
                throw new Error("Error when trying to remove last stored block")
            }
        }
    }

    async insertBlock(block) {
        let key = PREFIX_BLOCK+block.hash
        let data = JSON.stringify(
            {
                h:block.height,
                t:block.timestamp,
                ph:block.previousHash
            }
        )
    
        return await this.addTransaction("put", key, data)
    }

    async insertTransaction(tx) {
        let key = PREFIX_TRANSACTION+tx.hash.substring(0, 16)
        let data = JSON.stringify(
            {
                bh:tx.blockHash
            }
        )

        return await this.addTransaction("put", key, data)
    }

    async insertInputHint(input) {
        let key = PREFIX_INPUT_HINT+input.txHash+input.prevTxHash.substring(0, 16)+input.prevOutputIndex

        return await this.addTransaction("put", key, "")
    }

    async insertInput(input) {
        let key = PREFIX_INPUT+input.prevTxHash.substring(0, 16)+input.prevOutputIndex
        let data = JSON.stringify(
            {
                th:input.txHash
            }
        )

        return await this.addTransaction("put", key, data)
    }

    async removeOutputWithInput(input) {
        let outputHintKey = PREFIX_OUTPUT_HINT+input.prevTxHash+input.prevOutputIndex
        let deletedOutputHintKey = null
        let outputHintValue = null
        let outputKey = null
        let outputScriptPubKey = null
        let deletedOutputKey = null
        try {
            deletedOutputHintKey = PREFIX_OUTPUT_HINT_DELETED+input.blockHash+input.prevTxHash+input.prevOutputIndex
            outputHintValue = await this.db.get(outputHintKey)
            outputKey = PREFIX_OUTPUT+outputHintValue+input.prevTxHash+input.prevOutputIndex
            deletedOutputKey = PREFIX_OUTPUT_DELETED+input.blockHash+outputHintValue+input.prevTxHash+input.prevOutputIndex
            outputScriptPubKey = await this.db.get(outputKey)
        } catch (err) {
            let outputScript = this.getTransactionValue(outputHintKey)
            if (outputScript != null){
                if (!this.removeTransaction(PREFIX_OUTPUT+outputScript+input.prevTxHash+input.prevOutputIndex, input.blockHash)){
                    throw Error("Missing output("+PREFIX_OUTPUT+outputScript+input.prevTxHash+input.prevOutputIndex+") match for input "+JSON.stringify(input))
                }
                if (!this.removeTransaction(outputHintKey, input.blockHash)){
                    throw Error("Missing outputHintKey("+outputHintKey+") match for input "+JSON.stringify(input))
                }
            } else {
                console.log("Warning: Missing outputHintKey("+outputHintKey+") for input "+JSON.stringify(input)+" - output may have been indexed before REMOVE_SPENT was enabled")
            }
            return true
        }
        
        //The output won't be deleted, instead it will remain in the database and it will be deleted later
        await this.addTransaction("put", deletedOutputHintKey, outputHintValue)
        await this.addTransaction("put", deletedOutputKey, outputScriptPubKey)
        
        await this.addTransaction("del", outputKey)
        await this.addTransaction("del", outputHintKey)
        return true
    }

    async insertOutputHint(output){
        let key = PREFIX_OUTPUT_HINT+output.txHash+output.outputIndex
        let data = output.scriptPubKey

        return await this.addTransaction("put", key, data)
    }

    async insertOutput(output) {
        let key = PREFIX_OUTPUT+output.scriptPubKey+output.txHash+output.outputIndex
        let data = JSON.stringify(
            {
                v: output.value,
                h: output.height != null ? output.height : -1,
                t: output.fullTxHash || null
            },
            (_, v) => typeof v === 'bigint' ? v.toString() : v
        )

        return await this.addTransaction("put", key, data)
    }
  
    async getOutputScriptBlock(outputScript){
        let key = PREFIX_OUTPUT_SCRIPT_BLOCK+outputScript
    
        try {
            let value = await this.db.get(key)
            value = JSON.parse(value)
            return value
        } catch (err) {
            if (err.notFound) {
                return null
                //Do nothing
            } else {
                throw err
            }
        }
    }
  
    async processDeletedOutputs(blockHash, recover = true){
        if (this.deletedTransactionArray.has(blockHash)){
            if (recover){
                this.deletedTransactionArray.forEach((value, key) => {
                    this.transactionArray.set(key, value)
                });
            }
            
            this.deletedTransactionArray.delete(blockHash)
        }
        
        await this.processDeletedOutputsInDb(blockHash, recover, false)
        await this.processDeletedOutputsInDb(blockHash, recover, true)
    }
  
    async processDeletedOutputsInDb(blockHash, recover = true, processOutputHints = false){
        let prefixBlockHash = null
        if (processOutputHints){
            prefixBlockHash = PREFIX_OUTPUT_HINT_DELETED+blockHash
        } else {
            prefixBlockHash = PREFIX_OUTPUT_DELETED+blockHash
        }

        const options = {
            gte: prefixBlockHash,
            lte: prefixBlockHash+"\xFF",
            keys: true,
            values: true
        }

        const stream = this.db.createReadStream(options);

        for await (const data of stream) {
            let deletedKey = data.key.toString("utf-8")

            if (recover){
                let outputKey = deletedKey.substr(prefixBlockHash.length)
                await this.addTransaction("put", outputKey, data.value)
            }

            await this.addTransaction("del", deletedKey, "")
        }
    }
    
    async recoverDeletedOutputsHints(blockHash){
        let prefixBlockHash = PREFIX_OUTPUT_HINT_DELETED+blockHash

        const options = {
            gte: prefixBlockHash,
            lte: prefixBlockHash+"\xFF",
            keys: true,
            values: true
        }

        const stream = this.db.createReadStream(options);

        for await (const data of stream) {
            let deletedKey = data.key.toString("utf-8")
            let outputHintKey = deletedKey.substr(prefixBlockHash.length)

            await this.addTransaction("put", outputHintKey, data.value)
            await this.addTransaction("del", deletedKey, "")
        }
    }
  
    async removeOutputScriptsInBlock(blockHash){
        let prefixBlockHash = PREFIX_BLOCK_OUTPUT_SCRIPT+blockHash

        const options = {
            gte: prefixBlockHash,
            lte: prefixBlockHash+"\xFF",
            keys: true,
            values: true
        }

        const stream = this.db.createReadStream(options);

        for await (const data of stream) {
            let dataString = data.key.toString("utf-8")

            let outputScript = dataString.substr(prefixBlockHash.length)
            let outputScriptBlockKey = PREFIX_OUTPUT_SCRIPT_BLOCK+outputScript

            await this.addTransaction("del", outputScriptBlockKey, "")
            await this.addTransaction("del", dataString, "")
        }
    }
  
    async insertOutputScriptBlock(outputScript, blockHash, txHash, blockHeight){
        //Check if the output script already exists
        let key = PREFIX_OUTPUT_SCRIPT_BLOCK+outputScript
        let hintKey = PREFIX_BLOCK_OUTPUT_SCRIPT+blockHash+outputScript
        
        try {
            let value = await this.db.get(key)
        } catch (err) {
            if (err.notFound) {
                let data = JSON.stringify(
                    {
                        b:blockHash,
                        h:blockHeight,
                        txid:txHash
                    }
                )
                
                await this.addTransaction("put", key, data)
                await this.addTransaction("put", hintKey, "")
                    
                return true
            } else {
                throw err
            }
        }
        
        return true
        //Insert script-block and block-script
    }
  
    async getBlock(blockHash){
        let key = PREFIX_BLOCK+blockHash
        let value = null
        try {
            value = await this.db.get(key)
            value = JSON.parse(value)
            
            
        } catch (err) {
            if (err.notFound) {
                //Do nothing
            } else {
                throw err
            }
        }
        
        return value
    }

    async getInput(txHash8, outputIndex){
        let key = PREFIX_INPUT+txHash8+outputIndex
        
        let value = null
        try {
            value = await this.db.get(key)
        } catch (err) {
            if (err.notFound) {
                //Do nothing
            } else {
                throw err
            }
        }
        
        return value
    }
  
    async getValuesFromKeyPattern(pattern){
        return new Promise((resolve, reject) => {
            var values = []
            const options = {
                gte: pattern,
                lte: pattern+"\xFF",
                keys: true,
                values: true
            }
          
            const stream = this.db.createReadStream(options);
          
            stream.on('data', function(data) {
                let dataKey = data.key.toString("utf-8")
                let dataValue = data.value.toString("utf-8")
                
                values.push({
                    key: dataKey,
                    value: dataValue
                })
            })

            stream.on('error', function(err) {
                console.log("Error getting values from patterns")
                console.log(err)
                reject(err)
            })

            stream.on('end', function() {
                resolve(values)
            })
        })
    }
  
    async getTransaction(txHash){
        try {
            return await this.db.get(txHash)
        } catch (err){
            if (err.notFound){
                return null
            }
            
            throw err
        }
    }
  
    async getTransactions(txHashPrefix){
        return new Promise((resolve, reject) => {
            var transactions = []
            const options = {
                gte: PREFIX_TRANSACTION+txHashPrefix,
                lte: PREFIX_TRANSACTION+txHashPrefix+"\xFF",
                keys: true,
                values: true
            }
          
            const stream = this.db.createReadStream(options);
          
            stream.on('data', function(data) {
                let dataString = data.key.toString("utf-8")
                
                //Find its transaction and input(if it exists)
                let txHash = dataString
                let dataJson = JSON.parse(data.value.toString())
                
                transactions.push({
                    txid: txHash,
                    block_hash: dataJson.bh
                })
            })

            stream.on('error', function(err) {
                console.log("Error getting transactions")
                console.log(err)
                reject(err)
            })

            stream.on('end', function() {
                resolve(transactions)
            })
        })
    }

    async deleteOutputsByHint(txid){
        txid = txid.substr(0, 16)

        const options = {
            gte: PREFIX_OUTPUT_HINT+txid,
            lte: PREFIX_OUTPUT_HINT+txid+"\xFF",
            keys: true,
            values: true
        }

        var outputsCount = 0
        const dbStream = this.db.createReadStream(options)

        for await (const data of dbStream) {
            const outputIndex = data.key.toString("utf-8")
            const scriptPubKey = data.value.toString("utf-8")

            await this.addTransaction("del", PREFIX_OUTPUT + scriptPubKey + txid + outputIndex, null)
            await this.addTransaction("del", data.key, null)

            outputsCount = outputsCount + 1
        }

        return outputsCount
    }

    async deleteInputsByHint(txid){
        txid = txid.substr(0, 16)

        const options = {
            gte: PREFIX_INPUT_HINT+txid,
            lte: PREFIX_INPUT_HINT+txid+"\xFF",
            keys: true,
            values: true
        }

        var inputsCount = 0
        const dbStream = this.db.createReadStream(options)

        for await (const data of dbStream) {
            const keyString = data.key.toString("utf-8")
            const prevOutputTxHash = keyString.substr(1 + 16, 16)
            const prevOutputIndex = keyString.substr(1 + 16 + 16)

            await this.addTransaction(
                "del",
                PREFIX_INPUT+prevOutputTxHash+prevOutputIndex,
                null
            )
            await this.addTransaction(
                "del",
                data.key,
                null
            )

            inputsCount = inputsCount + 1
        }

        return inputsCount
    }

    async deleteOutputsByHints(txids){
        if (txids.length == 0){
            return 0
        }

        let outputsDeleted = 0

        for (let nextTxidIndex in txids){
            let nextTxid = txids[nextTxidIndex]
            let outputsDeletedTxid = await this.deleteOutputsByHint(nextTxid)
            outputsDeleted = outputsDeleted + outputsDeletedTxid
        }

        return outputsDeleted
    }

    async deleteInputsByHints(txids){
        if (txids.length == 0){
            return 0
        }

        let inputsDeleted = 0

        for (let nextTxidIndex in txids){
            let nextTxid = txids[nextTxidIndex]
            let inputsDeletedTxid = await this.deleteInputsByHint(nextTxid)
            inputsDeleted = inputsDeleted + inputsDeletedTxid
        }

        return inputsDeleted
    }

    async deleteInputs(txids){
        if (txids.length == 0){
            return 0
        }

        const options = {
            gte: PREFIX_INPUT,
            lte: PREFIX_INPUT+"\xFF",
            keys: true,
            values: true,
        }

        let txids8 = []
        for (let nextTxidIndex in txids){
            txids8.push(txids[nextTxidIndex].toString("utf-8"))
        }

        const dbStream = this.db.createReadStream(options)
        var inputsCount = 0

        for await (const data of dbStream) {
            const txHash = JSON.parse(data.value)["th"]

            if (!txids8.includes(txHash)) {
                await this.addTransaction(
                    "del",
                    data.key,
                    null
                )

                inputsCount = inputsCount + 1
            }
        }

        return inputsCount
    }

    async deleteTransaction(txid) {
        let key = PREFIX_TRANSACTION+txid.substring(0, 16)

        return await this.addTransaction("del", key, null)
    }

    async deleteBlock(blockHash) {
        let key = PREFIX_BLOCK+blockHash

        return await this.addTransaction("del", key, null)
    }

    async deleteAndCompareTxsNotInList(txidList){
        let deletedTxs = []
        const options = {
            gte: PREFIX_TRANSACTION,
            lte: PREFIX_TRANSACTION+"\xFF",
            keys: true
        }

        const dbStream = this.db.createReadStream(options)

        for await (const data of dbStream) {
            const txid = data.key.toString("utf-8").substr(1);
            const txidIndex = bs(txidList, txid, function(element, needle) { return needle.localeCompare(element.substring(0, 16)) })

            if (txidIndex == -1) {
                await this.deleteTransaction(txid)
                deletedTxs.push(txid)
            } else {
                txidList.splice(txidIndex, 1)
            }
        }

        let outputsDeleted = await this.deleteOutputsByHints(deletedTxs)
        let inputsDeleted = await this.deleteInputsByHints(deletedTxs)

        return {transactionsDeleted: deletedTxs.length, outputsDeleted: outputsDeleted, inputsDeleted: inputsDeleted}
    }
    
    async getOutputsScriptPubKey(scriptPubKey){
        let thisObject = this
        
        return new Promise((resolve, reject) => {
            var outputs = []
            const options = {
                gte: PREFIX_OUTPUT+scriptPubKey,
                lte: PREFIX_OUTPUT+scriptPubKey+"\xFF",
                keys: true,
                values: true
            }

            const stream = this.db.createReadStream(options);

            stream.on('data', async function(data) {
                let dataString = data.key.toString("utf-8")
                
                //Find its transaction and input(if it exists)
                let txHash8 = dataString.substr(
                    PREFIX_OUTPUT.length + 
                    64, //scriptPubKey length. 32 bytes (it's a sha256)
                    16 //the first 8 bytes from the txid
                )
                let n = parseInt(dataString.substr(PREFIX_OUTPUT.length + 
                    64 +//scriptPubKey length. 32 bytes (it's a sha256)
                    16
                ))
                let dataJson = JSON.parse(data.value.toString())
                
                outputs.push({
                    txid: txHash8,
                    fullTxid: dataJson.t || null,
                    vout: n,
                    value: dataJson.v,
                    height: dataJson.h != null ? dataJson.h : -1
                })
            })

            stream.on('error', function(err) {
                reject(err)
            })

            stream.on('end', function() {
                resolve(outputs)
            })
        })
    }
    
    async getLastBlock(){
        let thisObject = this

        return new Promise((resolve, reject) => {
            var outputs = []
            const options = {
                gte: PREFIX_BLOCK,
                lte: PREFIX_BLOCK+"\xFF",
                keys: true,
                values: true
            }
            var maxBlockHeight = null
            var maxBlockObj = null
            const stream = this.db.createReadStream(options);

            stream.on('data', async function(data) {
                let dataString = data.key.toString("utf-8")

                let blockHash = dataString.substr(
                    PREFIX_BLOCK.length
                )
                let dataJson = JSON.parse(data.value.toString())

                if ((maxBlockHeight == null) || dataJson.h > maxBlockHeight){
                    maxBlockHeight = dataJson.h
                    maxBlockObj = {
                        hash: blockHash,
                        height: dataJson.h,
                        timestamp: dataJson.t,
                        previousHash: dataJson.ph
                    }
                }
            })

            stream.on('error', function(err) {
                reject(err)
            })

            stream.on('end', function() {
                resolve(maxBlockObj)
            })
        })
    }
    
    async getLastStoredBlocks(){
        let thisObject = this

        return new Promise((resolve, reject) => {
            var result = []
            const options = {
                gte: PREFIX_STORED_BLOCK,
                lte: PREFIX_STORED_BLOCK+"\xFF",
                keys: true,
                values: true
            }
            const stream = this.db.createReadStream(options);

            stream.on('data', async function(data) {
                let dataString = data.key.toString("utf-8")

                let blockHash = dataString.substr(
                    PREFIX_STORED_BLOCK.length
                )
                result.push(blockHash)
            })

            stream.on('error', function(err) {
                reject(err)
            })

            stream.on('end', function() {
                resolve(result)
            })
        })
    }
}

module.exports = LevelUpStore