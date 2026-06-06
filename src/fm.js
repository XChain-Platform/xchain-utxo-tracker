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
 * XChain UTXO Tracker - FileManager Class
 * 
 * This file handles reading and writing to UTXO tracker files
 *
 ********************************************************************/

// Load required libraries
const fs = require('fs');
const EventEmitter = require('events')
const BLOCK_FILE_PREFIX = "blocks_data_"
const TRANSACTION_FILE_PREFIX = "transactions_data_"
const INPUT_FILE_PREFIX = "inputs_data_"
const OUTPUT_FILE_PREFIX = "outputs_data_"

const MAX_STORAGE = 107374182400 //100GB 
//const MAX_STORAGE = 2147483648 //2GB FOR TESTING
        
const FILE_MAX_BYTES = 471859200//450MB
//const FILE_MAX_BYTES = 536870912//512MB
//const FILE_MAX_BYTES = 1073741824//1GB

const DELIMITER = ","

class FileManager extends EventEmitter{
  static FILE_TYPE_BLOCK = 0
  static FILE_TYPE_TRANSACTION = 1
  static FILE_TYPE_INPUT = 2
  static FILE_TYPE_OUTPUT = 3
    
  constructor() {
    super()
    this.lastBlockFile = -1
    this.lastTransactionFile = -1
    this.lastInputFile = -1
    this.lastOutputFile = -1
    
    this.blockStream = null
    this.blockStreamWritten = 0
    this.transactionStream = null
    this.transactionStreamWritten = 0
    this.inputStream = null
    this.inputStreamWritten = 0
    this.outputStream = null
    this.outputStreamWritten = 0    
    
    this.storageSize = 0
  }
  
  async getNewStream(fileType){
      switch(fileType){
          case FileManager.FILE_TYPE_BLOCK:
            if (this.blockStream != null){
                await this.blockStream.end()
                this.addFileSize(this.blockStream.path)
                this.emit('new_file',{type:FileManager.FILE_TYPE_TRANSACTION,path:this.blockStream.path})
            }
            
            this.lastBlockFile = this.lastBlockFile + 1
            this.blockStream = await fs.createWriteStream(BLOCK_FILE_PREFIX+this.lastBlockFile+'.csv', {flags: 'a'});
            this.blockStreamWritten = 0
            
            return this.blockStream
          case FileManager.FILE_TYPE_TRANSACTION:
            if (this.transactionStream != null){
                await this.transactionStream.end()
                this.addFileSize(this.transactionStream.path)
                this.emit('new_file',{type:FileManager.FILE_TYPE_TRANSACTION,path:this.transactionStream.path})
            }
            
            this.lastTransactionFile = this.lastTransactionFile + 1
            this.transactionStream = await fs.createWriteStream(TRANSACTION_FILE_PREFIX+this.lastTransactionFile+'.csv', {flags: 'a'});
            this.transactionStreamWritten = 0
            
            return this.transactionStream
          case FileManager.FILE_TYPE_INPUT:
            if (this.inputStream != null){
                await this.inputStream.end()
                this.addFileSize(this.inputStream.path)
                this.emit('new_file',{type:FileManager.FILE_TYPE_INPUT,path:this.inputStream.path})
            }
            
            this.lastInputFile = this.lastInputFile + 1
            this.inputStream = await fs.createWriteStream(INPUT_FILE_PREFIX+this.lastInputFile+'.csv', {flags: 'a'});
            this.inputStreamWritten = 0
            
            return this.inputStream
          case FileManager.FILE_TYPE_OUTPUT:
            if (this.outputStream != null){
                await this.outputStream.end()
                this.addFileSize(this.outputStream.path)
                this.emit('new_file',{type:FileManager.FILE_TYPE_OUTPUT,path:this.outputStream.path})
            }
            
            this.lastOutputFile = this.lastOutputFile + 1
            this.outputStream = await fs.createWriteStream(OUTPUT_FILE_PREFIX+this.lastOutputFile+'.csv', {flags: 'a'});
            this.outputStreamWritten = 0
            
            return this.outputStream
      }
  }
  
  addFileSize(path){
      const {size} = fs.statSync(path)
      
      this.storageSize = this.storageSize + size
  }
  
  removeFileSize(path){
      const {size} = fs.statSync(path)
      
      this.storageSize = this.storageSize - size
  }
  
  isStorageFull(){
      return this.storageSize >= MAX_STORAGE
  }
  
  async getStream(fileType){
      let stream = null
      
      switch(fileType){
          case FileManager.FILE_TYPE_BLOCK:
            stream = this.blockStream           
            break
          case FileManager.FILE_TYPE_TRANSACTION:
            stream = this.transactionStream
            break
          case FileManager.FILE_TYPE_INPUT:
            stream = this.inputStream
            break
          case FileManager.FILE_TYPE_OUTPUT:
            stream = this.outputStream
            break
      }
      
      if (stream == null){
          stream = await this.getNewStream(fileType)
      }
      
      return stream
  }
  
  
  async getBytesWritten(fileType){
      switch(fileType){
          case FileManager.FILE_TYPE_BLOCK:
            return this.blockStreamWritten
          case FileManager.FILE_TYPE_TRANSACTION:
            return this.transactionStreamWritten            
          case FileManager.FILE_TYPE_INPUT:
            return this.inputStreamWritten          
          case FileManager.FILE_TYPE_OUTPUT:
            return this.outputStreamWritten
      }
  }
  
  addBytesWritten(fileType, amount){
      switch(fileType){
         case FileManager.FILE_TYPE_BLOCK:
            this.blockStreamWritten = this.blockStreamWritten + amount
            break
          case FileManager.FILE_TYPE_TRANSACTION:
            this.transactionStreamWritten = this.transactionStreamWritten + amount
            break
          case FileManager.FILE_TYPE_INPUT:
            this.inputStreamWritten = this.inputStreamWritten + amount
            break
          case FileManager.FILE_TYPE_OUTPUT:
            this.outputStreamWritten = this.outputStreamWritten + amount
            break
      }
      
      return this.transactionStreamWritten
  }
  
  async writeToFile(fileType, data){
      let stream = await this.getStream(fileType)
      let bufferString = Buffer.from(data, 'utf-8')
      
      
      let bytesAmount = bufferString.length
      let bytesWritten = await this.getBytesWritten(fileType)
      
      if (bytesWritten + bytesAmount > FILE_MAX_BYTES){
          stream = await this.getNewStream(fileType)
      }
      
      this.addBytesWritten(fileType, bytesAmount)
      return await stream.write(bufferString)
  }
  
  async insertBlock(block_hash, height, timestamp, previous_block_hash) {
    await this.writeToFile(FileManager.FILE_TYPE_BLOCK, block_hash+DELIMITER+height+DELIMITER+timestamp+DELIMITER+previous_block_hash+"\n")
  }

  async insertTransaction(tx_hash, block_hash) {
    await this.writeToFile(FileManager.FILE_TYPE_TRANSACTION, tx_hash+DELIMITER+block_hash+"\n")
  }

  async insertInput(tx_hash,input_index,prev_tx_hash,prev_output_index) {
    await this.writeToFile(FileManager.FILE_TYPE_INPUT, tx_hash+DELIMITER+input_index+DELIMITER+prev_tx_hash+DELIMITER+prev_output_index+"\n")
  }

  async insertOutput(tx_hash,output_index,value,script_pub_key) {
    await this.writeToFile(FileManager.FILE_TYPE_OUTPUT, tx_hash+DELIMITER+output_index+DELIMITER+value+DELIMITER+script_pub_key+"\n")
  }
  
  async end(){
    await this.blockStream.end()
    await this.transactionStream.end()
    await this.inputStream.end()
    await this.outputStream.end()
    
    this.emit('new_file',{type:FileManager.FILE_TYPE_BLOCK,path:this.blockStream.path})
    this.emit('new_file',{type:FileManager.FILE_TYPE_TRANSACTION,path:this.transactionStream.path})
    this.emit('new_file',{type:FileManager.FILE_TYPE_INPUT,path:this.inputStream.path})
    this.emit('new_file',{type:FileManager.FILE_TYPE_OUTPUT,path:this.outputStream.path})
  }
  
  async removeFile(path, callback){
      this.removeFileSize(path)
      await fs.unlink(path, callback)
      return true
  }
  
  async removeFiles(){
    let regex = /[.]txt$/
    let filenames = fs.readdirSync('.')
    
    for (let nextFileNameIndex in filenames){
        let nextFileName = filenames[nextFileNameIndex]
        
        if (
            nextFileName.startsWith(BLOCK_FILE_PREFIX)
            || nextFileName.startsWith(TRANSACTION_FILE_PREFIX)
            || nextFileName.startsWith(INPUT_FILE_PREFIX)
            || nextFileName.startsWith(OUTPUT_FILE_PREFIX)      
        ) {
          fs.unlinkSync(nextFileName)
          console.log(nextFileName+" removed")
        }
    }
  }
}

module.exports = FileManager