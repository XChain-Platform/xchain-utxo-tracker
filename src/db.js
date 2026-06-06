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
 * XChain UTXO Tracker - Database Class
 * 
 * This file handles connecting to databases and running SQL queries
 *
 ********************************************************************/

// Load required libraries
const mariadb = require('mariadb');

class Database {
  constructor(url, port, dbName, user, password) {
	this.url = url
	this.port = port
	this.dbName = dbName
	this.user = user
	this.password = password
	
	const DUPLICATED_TRANSACTION = 1
	
	let connectionParams = {
		host: url,
		user: user,
		password: password,
		database: dbName,
		connectionLimit: 10,
		connectTimeout: 0,
		queryTimeout: parseInt(process.env.DB_QUERY_TIMEOUT) || 30000,
		port: port,
		permitLocalInfile: 'true'
	}
	  
	this.pool = mariadb.createPool(connectionParams)	 
	this.transactionConnection = null
	this.uniqueConnection = null
	
	this.blocksLoadDataQueue = []
	this.transactionsLoadDataQueue = []
	this.inputsLoadDataQueue = []
	this.outputsLoadDataQueue = []
	this.blocksLoadDataBusy = false
	this.transactionsLoadDataBusy = false
	this.inputsLoadDataBusy = false
	this.outputsLoadDataBusy = false
	
	this.debugTime = {}
	
	setInterval(this.keepAlive.bind(this), parseInt(process.env.UTXO_DB_KEEPALIVE_INTERVAL) || 10000);
  }
  
  async sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
  }
  
  async verifyDatabaseExists(){
	let connectionParams = {
		host: this.url,
		user: this.user,
		password: this.password,
		port: this.port
	}

	while (true){
		try{
			let connection = await mariadb.createConnection(connectionParams)
			await connection.query("CREATE DATABASE IF NOT EXISTS "+this.dbName)
			await connection.end()
			return true
			console.log("Database created!")
		} catch (e) {
			console.log(e)
			console.log("There were problems when trying to create the database. Trying again...")
			await this.sleep(5000)
			//throw Error(e)
		}
	}
  }

  /*async keepAlive() { 
    try {
		
		console.log("Ping to the database!!!")
		console.log("Ping to the database!!!")
		console.log("Ping to the database!!!")
		let connection = await this.getConnection()
		
		var query = 'select 1';
		
		var results = await connection.query(query)
		await connection.release()
	} catch(e){
		console.log("Error trying to ping the database: ", e)
	}
  }*/
  

  async beginTransaction(){
    if (this.transactionConnection != null){
	    await this.endTransaction()
	}
	
	this.transactionConnection = await this.getConnection()
	this.transactionConnection.beginTransaction()
  }

  async endTransaction(){
	  if (this.transactionConnection != null){
	      await this.transactionConnection.rollback()
		  await this.transactionConnection.release()
		  this.transactionConnection = null
	  }  
  }

  async beginUniqueConnection(){
	if (this.uniqueConnection != null){
	    await this.endUniqueConnection()
	}
	
	this.uniqueConnection = await this.getConnection()
  }

  async endUniqueConnection(){
	  if (this.uniqueConnection != null){
	      await this.uniqueConnection.release()
		  this.uniqueConnection = null
	  }  
  }
  
  async commitTransaction(){
	  if (this.transactionConnection != null){
		  try {
			await this.transactionConnection.commit()
			return true
		  } catch (e){
		    console.log(e)
			console.log("There was an error trying to commit a transaction")
			this.transactionConnection = null //the transaction is not valid anymore
		  }
	  }

      return false	  
  }

  async getConnection() {
    if (this.transactionConnection){
		return this.transactionConnection
	} else if (this.uniqueConnection){
		return this.uniqueConnection
	}
	
	var connection = null
		
	while (connection == null){		
		try {
			connection = await this.pool.getConnection()
			//console.log("Connected to database!")
		} catch (e){
			console.log(e)
			console.log("Can't connect to mariadb. Trying again...")
			connection = null
			await this.sleep(1000)
		}
	}
	return connection
  }

  async endConnection(connection){
	  if (!this.transactionConnection){
		
		try {
			await connection.release()  
		} catch(err){
			console.log("couldn't end database connection: ",err)
		}
		return true
	  }
	  
	  return false
  }

  async createTables() {
	await this.verifyDatabaseExists()
	
	const blockTable = `
      CREATE TABLE IF NOT EXISTS Block (
		block_index INT UNIQUE,
        block_hash VARCHAR(64) UNIQUE,
        block_time INTEGER,
		previous_block_hash VARCHAR(64) UNIQUE,
		PRIMARY KEY (block_hash)
      ) ENGINE=Aria`;

//CREATE TABLE IF NOT EXISTS Transaction (
	  

    const transactionTable = `
      CREATE TABLE IF NOT EXISTS Transaction (
	    tx_index INTEGER UNIQUE,
	    tx_hash VARCHAR(64) UNIQUE,
        block_index INTEGER NOT NULL,
		source VARCHAR(64),
		destination VARCHAR(64),
		amount INTEGER,
		fee INTEGER,
		data BLOB,
		FOREIGN KEY (block_index) REFERENCES block(block_index),
		PRIMARY KEY (tx_hash)
      ) ENGINE=Aria`;

    const blockIndexIndex = `
      CREATE INDEX IF NOT EXISTS block_block_index_index ON Block (block_index)`;

	const transactionIndexIndex = `
      CREATE INDEX IF NOT EXISTS transaction_tx_index_index ON Transaction (tx_index)`;

	
    let connection = await this.getConnection()
	await connection.query(blockTable, (err) => {
      if (err) {
        console.error('Error creating Block table:', err);
        return;
      }
      console.log('Block table created!');
    });

    await connection.query(transactionTable, (err) => {
      if (err) {
        console.error('Error creating Transaction table:', err);
        return;
      }
      console.log('Transaction table created!');
    });
	
	await connection.query(blockIndexIndex, (err) => {
      if (err) {
        console.error('Error creating index for block_index in table block:', err);
        return;
      }
      console.log('block_block_index_index created!');
    });
	
	await connection.query(transactionIndexIndex, (err) => {
      if (err) {
        console.error('Error creating index for tx_index in table transaction:', err);
        return;
      }
      console.log('transaction_tx_index_index created!');
    });
	
	await connection.release()
  }

  async getLastBlock(){
	const query = `
      SELECT MAX(block_index) AS max_height FROM Block ;
    `;
	
	let connection = await this.getConnection()
	
	try {
		const rows = await connection.query(query)
		await connection.release()
		if (rows.length > 0){
			if (rows[0]["max_height"] == null){
				return -1
			} else {
				return rows[0]["max_height"]
			}
		} else {
			return -1	
		}
	} catch (err) {
		console.error('Error selecting max block height:', err);
		return false;
	}
  }

  async insertBlock(block) {
    const query = `
      INSERT INTO Block (
        block_index,
		block_hash,
        block_time,
        previous_block_hash
      ) VALUES (?, ?, ?, ?);
    `;

    
	let connection = await this.getConnection()
	
	try {
		await connection.query(query, [
			block.index,
			block.hash,
			block.time,
			block.previousBlockHash
		])
		
		return true
	} catch (err) {
		console.error('Error inserting block:', err);
		if (this.transactionConnection){
			await this.endTransaction()
		}
		return false;
	}
  }

  async insertTransaction(tx) {
    const query = `
      INSERT INTO Tx (
        tx_index,
        tx_hash,
		block_index,
		source,
		destination,
		amount,
		fee,
		data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?);
    `;

	let connection = await this.getConnection()
	
	try {
		await connection.query(query, [
			tx.index,
			tx.hash,
			tx.block_index
			tx.source,
			tx.destination,
			tx.amount,
			tx.fee,
			tx.data
		])
		
		return true
	} catch (err) {
		if (err.errno == 1062){
			return this.DUPLICATED_TRANSACTION
		} else {
			console.error('Error inserting transaction:', err);
			if (this.transactionConnection){
				await this.endTransaction()
			}
			return false;
		}
	}	
  }
}

module.exports = Database