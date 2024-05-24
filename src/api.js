const dotenv = require('dotenv')
dotenv.config()

//const Database = require('./db.js')
const LevelUpStore = require('./LevelUpDb.js')
//const FileManager = require('./fm.js')
const express = require('express');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const cors = require('cors');
const XChainAddressIndexer  = require('./XChainAddressIndexer');
const jsonRouter = require('express-json-rpc-router')


const NETWORK = process.env.NETWORK
const NODE_URL =  process.env.NODE_URL
const NODE_USER =  process.env.NODE_USER
const NODE_PASSWORD =  process.env.NODE_PASSWORD
const DB_URL =  process.env.DB_URL
const DB_PORT =  process.env.DB_PORT
const DB_NAME =  process.env.DB_NAME
const DB_USER =  process.env.DB_USER
const DB_PASSWORD =  process.env.DB_PASSWORD


async function startApi(){
	//Start the indexer
	const indexer = new XChainAddressIndexer(NETWORK, NODE_URL, NODE_USER, NODE_PASSWORD, DB_NAME);
	indexer.start()

	// Create the app
	const app = express();

	// Use Helmet to increase security
	app.use(helmet());

	// Allow JSON requests
	app.use(bodyParser.json());

	// Allow CORS for development
	app.use(cors());


	const jsonRpcController = {

		// Function to create transactions hex for a given data and encoding type
		async get_utxos({address}) {
			let utxos = await indexer.getUtxosAddress(address)

			// Return utxos
			return { utxos: utxos};
		},
		// Function to retrieve the oldest tx of an address
		async get_oldest_tx({address}) {
			let oldestTx = await indexer.getOldestTransaction(address)

			// Return utxos
			return { oldest_tx: oldestTx};
		},
		
		async get_input_from_key_pattern({pattern}) {
			if (pattern.length < 32){
				return {error: "pattern is too short"}
			} else {
			
				let results = await db.getValuesFromKeyPattern(pattern)

				// Return utxos
				return { result: results};
			}
		}
	}

	// Allow JSON-RPC requests
	app.use(jsonRouter({methods: jsonRpcController}))


	// Start the server
	app.listen(3000, () => {
	  console.log('API listening on port 3000');
	});
}

startApi()