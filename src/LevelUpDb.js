var levelup = require('levelup')
var leveldown = require('leveldown')
var memdown = require('memdown')
const encode = require('encoding-down')
const bs = require("binary-search")

const PREFIX_LAST_BLOCK_HEIGHT = "LAST_BLOCK_HEIGHT"
const PREFIX_BLOCK = "B"
const PREFIX_TRANSACTION = "T"
const PREFIX_INPUT = "I"
const PREFIX_OUTPUT = "O"
const PREFIX_OUTPUT_HINT = "H"
const PREFIX_INPUT_HINT = "J"

class LevelUpStore {
  constructor(dbName, inMemory = false) {
	this.dbName = dbName
	this.db = null
	this.transactionArray = []
	this.inMemory = inMemory
  }
  
  async sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
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

  async beginTransaction(){
	  this.transactionArray = []
  }

  async endTransaction(){
	  try {
		await this.db.batch(this.transactionArray)
		this.transactionArray = null
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
	  
	  if (this.transactionArray != null){
		this.transactionArray.push({
			type:"put",
			key: key,
			value: height.toString(16)
		})
	} else {
		return await this.db.put(key, data)
	}
  }

  async insertBlock(block) {
	let key = PREFIX_BLOCK+block.hash
	let data = JSON.stringify(
		{
			h:block.height,
			t:block.timestamp
		}
	)
	
	if (this.transactionArray != null){
		this.transactionArray.push({
			type:"put",
			key: key,
			value: data
		})
	} else {
		return await this.db.put(key, data)
	}
  }

  async insertTransaction(tx) {
    let key = PREFIX_TRANSACTION+tx.hash
	let data = JSON.stringify(
		{
			bh:tx.blockHash
		}
	)
	
	if (this.transactionArray != null){
		this.transactionArray.push({
			type:"put",
			key: key,
			value: data
		})
	} else {
		return await this.db.put(key, data)
	}
  }

	async insertInputHint(input) {
		let key = PREFIX_INPUT_HINT+input.txHash+input.prevTxHash+input.prevOutputIndex
		
		if (this.transactionArray != null){
			this.transactionArray.push({
				type:"put",
				key: key,
				value: ""
			})
		} else {
			return await this.db.put(key, data)
		}
	}

	async insertInput(input) {
		let key = PREFIX_INPUT+input.prevTxHash+input.prevOutputIndex
		let data = JSON.stringify(
			{
				th:input.txHash
			}
		)

		if (this.transactionArray != null){
			this.transactionArray.push({
				type:"put",
				key: key,
				value: data
			})
		} else {
			return await this.db.put(key, data)
		}
	}

	async insertOutputHint(output){
		let key = PREFIX_OUTPUT_HINT+output.txHash+output.outputIndex
		let data = output.scriptPubKey

		if (this.transactionArray != null){
			this.transactionArray.push({
				type:"put",
				key: key,
				value: data
			})
		} else {
			return await this.db.put(key, data)
		}
	}

  async insertOutput(output) {
    let key = PREFIX_OUTPUT+output.scriptPubKey+output.txHash+output.outputIndex
	let data = JSON.stringify(
		{
			v:output.value
		}
	)
	
	if (this.transactionArray != null){
		this.transactionArray.push({
			type:"put",
			key: key,
			value: data
		})
	} else {
		return await this.db.put(key, data)
	}
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
			//console.log("requesting transactions that starts with "+txHashPrefix)
			
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
			//console.log("requesting transactions that starts with "+txHashPrefix)
			
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
		let thisLevelUp = this
		//console.log("Trying to delete and output using hint with "+txid)
		
		return new Promise((resolve, reject) => {
			txid = txid.substr(0, 16)
			
			const options = {
				gte: PREFIX_OUTPUT_HINT+txid,
				lte: PREFIX_OUTPUT_HINT+txid+"\xFF",
				keys: true,
				values: true
			}
			
			var outputsCount = 0
			const dbStream = this.db.createReadStream(options)
			dbStream.on('data', async function(data) {
				const outputIndex = data.key.toString("utf-8")
				const scriptPubKey = data.value.toString("utf-8")
				
				//console.log("The output index is "+outputIndex)
				//console.log("The output scriptpubkey is "+scriptPubKey)
				
				//delete the output
				thisLevelUp.transactionArray.push({
					type:"del",
					key: PREFIX_OUTPUT+scriptPubKey+txid+outputIndex,
					value: null
				})
				//delete the hint
				thisLevelUp.transactionArray.push({
					type:"del",
					key: data.key,
					value: null
				})
				
				outputsCount = outputsCount + 1
			})
			dbStream.on('error', function(err) {
				reject(err)
			})

			dbStream.on('end', function() {
				resolve(outputsCount)
			})
		})
	}

	async deleteInputsByHint(txid){
		let thisLevelUp = this
		//console.log("Trying to delete and input using hint with "+txid)
		
		return new Promise((resolve, reject) => {
			txid = txid.substr(0, 16)
			
			const options = {
				gte: PREFIX_INPUT_HINT+txid,
				lte: PREFIX_INPUT_HINT+txid+"\xFF",
				keys: true,
				values: true
			}
			
			var inputsCount = 0
			const dbStream = this.db.createReadStream(options)
			dbStream.on('data', async function(data) {
				const keyString = data.key.toString("utf-8")
				const prevOutputTxHash = keyString.substr(1 + 64, 16)
				const prevOutputIndex = keyString.substr(1 + 64 + 16)
				
				//delete the input
				thisLevelUp.transactionArray.push({
					type:"del",
					key: PREFIX_INPUT+prevOutputTxHash+prevOutputIndex,
					value: null
				})
				//delete the hint
				thisLevelUp.transactionArray.push({
					type:"del",
					key: data.key,
					value: null
				})
				
				inputsCount = inputsCount + 1
			})
			dbStream.on('error', function(err) {
				reject(err)
			})

			dbStream.on('end', function() {
				resolve(inputsCount)
			})
		})
	}

	async deleteOutputsByHints(txids){
		let thisLevelUp = this
		
		if (txids.length == 0){
			return 0
		} else {
			return new Promise(async(resolve, reject) => {
				let outputsDeleted = 0
				
				for (let nextTxidIndex in txids){
					let nextTxid = txids[nextTxidIndex]
					
					let outputsDeletedTxid = await this.deleteOutputsByHint(nextTxid)
					outputsDeleted = outputsDeleted + outputsDeletedTxid
				}
				
				resolve(outputsDeleted)				
			})
		}
	}

	async deleteInputsByHints(txids){
		let thisLevelUp = this
		
		if (txids.length == 0){
			return 0
		} else {
			return new Promise(async(resolve, reject) => {
				let inputsDeleted = 0
				
				for (let nextTxidIndex in txids){
					let nextTxid = txids[nextTxidIndex]
					
					let inputsDeletedTxid = await this.deleteInputsByHint(nextTxid)
					inputsDeleted = inputsDeleted + inputsDeletedTxid
				}
				
				resolve(inputsDeleted)				
			})
		}
	}

	async deleteInputs(txids){
		let thisLevelUp = this
		
		if (txids.length == 0){
			return 0
		} else {
			return new Promise(async(resolve, reject) => {
				const options = {
					gte: PREFIX_INPUT,
					lte: PREFIX_INPUT+"\xFF",
					keys: true,
					values: true,
				}
				
				let txids8 = []
				for (let nextTxidIndex in txids){
					//console.log(txids[nextTxidIndex])
					txids8.push(txids[nextTxidIndex].toString("utf-8"))
				}
				
				const dbStream = this.db.createReadStream(options)
				var inputsCount = 0
				dbStream.on('data', async function(data) {
					const txHash = JSON.parse(data.value)["th"]
					
					if (!txids8.includes(txHash)) {
						thisLevelUp.transactionArray.push({
							type:"del",
							key: data.key,
							value: null
						})
						
						inputsCount = inputsCount + 1
					}
				})
				dbStream.on('error', function(err) {
					reject(err)
				})

				dbStream.on('end', function() {
					//console.log(inputsCount+" inputs were deleted")
						
					resolve(inputsCount)
				})
			})
		}
	}

	async deleteTransaction(txid) {
		let key = PREFIX_TRANSACTION+txid

		if (this.transactionArray != null){
			this.transactionArray.push({
				type:"del",
				key: key,
				value: null
			})
		} else {
			return await this.db.del(key)
		}
	}


	async deleteAndCompareTxsNotInList(txidList){
		let thisLevelUp = this
		
		return new Promise((resolve, reject) => {
			let deletedTxs = []
			const options = {
				gte: PREFIX_TRANSACTION,
				lte: PREFIX_TRANSACTION+"\xFF",
				keys: true
			}
			
			const dbStream = this.db.createReadStream(options)
			
			dbStream.on('data', async function(data) {
				const txid = data.key.toString("utf-8").substr(1);
				const txidIndex = bs(txidList, txid, function(element, needle) { return needle.localeCompare(element) })	
					
				if (txidIndex == -1) {
					await thisLevelUp.deleteTransaction(txid)
					deletedTxs.push(txid)
				} else {
					txidList.splice(txidIndex, 1)
				}
			})
			
			dbStream.on('error', function(err) {
				reject(err)
			})

			dbStream.on('end', async function() {
				//console.log(deletedTxs.length+" transactions deleted from mempool")
				
				let outputsDeleted = await thisLevelUp.deleteOutputsByHints(deletedTxs)
				let inputsDeleted = await thisLevelUp.deleteInputsByHints(deletedTxs)
				
				resolve({transactionsDeleted: deletedTxs.length, outputsDeleted: outputsDeleted, inputsDeleted: inputsDeleted})
			})
		})
	}
	
	async getOutputsScriptPubKey(scriptPubKey){
		let thisObject = this
		
		return new Promise((resolve, reject) => {
			//console.log("scriptpubkey")
			//console.log(PREFIX_OUTPUT+scriptPubKey)
			
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
				
				/*let transactions = await thisObject.getTransactions(txHash8)
				
				if (transactions.length > 0){
					let transaction = transactions[0]
					
				} else {
					reject(new Error("There is no transaction with the prefix "+txHash8))
				}*/
				
				outputs.push({
					txid: txHash8,
					vout: n,
					value: dataJson.v
				})
			})

			stream.on('error', function(err) {
				reject(err)
			})

			stream.on('end', function() {
				//console.log("ending getting the outputs")
				resolve(outputs)
			})
		})
	}
}

module.exports = LevelUpStore