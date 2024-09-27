const util = require('util')
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
const bs = require("binary-search")

const CHECK_BLOCK_DELAY_MS = 1000 //1 second to continously ask for new block when all has been parsed
const DB_TRANSACTION_BLOCKS_QUANTITY = 100
const PARSE_MODE_FILES = 0
const PARSE_MODE_BULK_INSERTS = 1
const SYNCED_THRESHOLD = 3
const SATOSHI_UNIT = 100000000.0
const MEMPOOL_INTERVAL = 60000
const MEMPOOL_BATCH_SIZE = 1000

class XChainAddressIndexer {
	constructor(network, nodeUrl, nodePort, nodeUser, nodePassword, dbName) {
      this.network = CryptoNetworks.getBitcoinJsNetwork(network)
	  this.connector = new BlockchainConnector(nodeUrl, nodePort, nodeUser, nodePassword)
	  this.dbName = dbName
	  
	  this.db = null
	  this.mempoolDb = null
	  
	  this.parseMode = PARSE_MODE_BULK_INSERTS
	  
	  this.debugTime = {}
	  
	  this.synced = false
	  
	  this.blockchainInfoLastBlock = -1
	  this.mempoolInterval = null
	  this.mempoolBusy = false
    }
	
	async sleep(ms) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
	
	markTime(timeName){
		this.debugTime[timeName] = Date.now()
	}
	
	logTime(timeName){
		let endTime = Date.now()
		let msTime = (endTime - this.debugTime[timeName])
					
		console.log("Time('"+timeName+"'): "+(msTime)+"ms")
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
					nextOutput.height = nextOutputBlock.h
					nextOutput.confirmations = this.blockchainInfoLastBlock - nextOutputBlock.h + 1
				}
					
				nextOutput.txid = nextOutputTransaction.txid.substr(1)
				nextOutput.amount = nextOutput.value/SATOSHI_UNIT
				nextOutput.scriptPubKey = script.toString("hex")
			} else {
				throw new Error("There's no transaction for an output")
			}
			
			let nextOutputInput = await this.db.getInput(nextOutput.txid, nextOutput.vout)
			
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
		
		let outputs = await this.db.getOutputsScriptPubKey(scriptHash)
		
		let nextOutputIndex = 0
		let oldestOutput = null
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
	
	async parseTransaction(db, transaction, blockHash, addHints = false){
		let nextTxId = transaction.getId()
		let nextTxId8 = nextTxId.substring(0,16)
	
		let resultInfo = {
			inputsCount: 0,
			outputsCount: 0
		}
	
		await db.insertTransaction({hash:nextTxId, blockHash:blockHash})
		
		for (let txInputIndex=0;txInputIndex < transaction.ins.length;txInputIndex++){
			let nextInput = transaction.ins[txInputIndex]
			
			if (nextInput.index != 4294967295){//4294967295 = 0xFFFFFFFF. It's a Coinbase input, there's no need to trace it
				let outputTxHash = nextTxId
				
				await db.insertInput({prevTxHash:nextInput.hash.reverse().toString("hex"), prevOutputIndex:nextInput.index, txHash:nextTxId8})
					
				if (addHints){
					await db.insertInputHint({prevTxHash:nextInput.hash.reverse().toString("hex"), prevOutputIndex:nextInput.index, txHash:nextTxId8})
				}
				
				resultInfo["inputsCount"] = resultInfo["inputsCount"] + 1
			}
		}
		for (let txOutputIndex=0;txOutputIndex < transaction.outs.length;txOutputIndex++){
			let nextOutput = transaction.outs[txOutputIndex]
			let scriptHash = createHash('sha256').update(nextOutput.script).digest('hex')
			
			await db.insertOutput({scriptPubKey:scriptHash, txHash:nextTxId8, outputIndex:txOutputIndex, value:nextOutput.value})
			if (addHints){
				await db.insertOutputHint({scriptPubKey:scriptHash, txHash:nextTxId8, outputIndex:txOutputIndex})
			}
			resultInfo["outputsCount"] = resultInfo["outputsCount"] + 1
			
		}
		
		return resultInfo
	}
	
	async start(){
		this.db = new LevelUpStore(this.dbName)
		this.mempoolDb = new LevelUpStore("mempool"+this.dbName, true)
		await this.db.createDatabase()
		await this.mempoolDb.createDatabase()
		
		console.log("Indexing...")
		
		let lastProcessedBlockIndex = await this.db.getLastBlockHeight()
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
		
		while (true){
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
					throw Error("The last processed block height is greater than the last block from the network")
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
					nextBlockHex = await this.connector.getBlock(nextBlockHash)
				} catch (e){
					console.log("Error trying to get next block from the node. Trying again...")
					await this.sleep(3000)
					continue
				}
				
				var block = bitcoin.Block.fromHex(Buffer.from(nextBlockHex,"hex"))
				
				//Start a transaction if there are no blocks processed yet
				if (blocksQuantity == 0){
					await this.db.beginTransaction()
				}
				
				//Insert the processed block
				await this.db.insertBlock({hash:nextBlockHash, height:nextBlockHeight, timestamp:block.timestamp})
				blocksCount = blocksCount + 1				
				
				//Parse the transactions
				var transactions = block.transactions

				for (let txIndex=0;txIndex < transactions.length;txIndex++){
					let nextTransaction = transactions[txIndex]
					
					let countInfo = await this.parseTransaction(this.db, nextTransaction, nextBlockHash)
					
					transactionsCount = transactionsCount + 1
					inputsCount = inputsCount + countInfo["inputsCount"]
					outputsCount = outputsCount + countInfo["outputsCount"]
				}
				
				//If there are enough processed blocks, then add them to the database
				if ((blocksQuantity == DB_TRANSACTION_BLOCKS_QUANTITY-1) || (nextBlockHeight == this.blockchainInfoLastBlock)){
					console.log("Indexing block "+(nextBlockHeight)+"("+nextBlockHash+")")
					await this.db.setLastBlockHeight(nextBlockHeight)
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
			}
		}
	}
	
	async updateMempool(){
		if (!this.mempoolBusy){
			let mempoolStartTime = Date.now()
			//console.log("Mempool is not busy!")
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
						let nextTx = bitcoin.Transaction.fromHex(Buffer.from(nextTxHex,"hex"))

						let countInfo = await this.parseTransaction(this.mempoolDb, nextTx, null, true)
						
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

module.exports = XChainAddressIndexer