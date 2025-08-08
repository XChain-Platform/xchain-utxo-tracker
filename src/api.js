const dotenv = require('dotenv')
dotenv.config()

const { spawn, exec } = require('child_process');
const LevelUpStore = require('./LevelUpDb.js')
const fs = require('fs')
const express = require('express');
const bodyParser = require('body-parser');
const helmet = require('helmet');
const cors = require('cors');
const XChainUtxoTracker  = require('./XChainUtxoTracker');
const jsonRouter = require('express-json-rpc-router')
const { randomUUID } = require('crypto')
const path = require('path')

const NETWORK = process.env.NETWORK
const NODE_URL =  process.env.NODE_URL
const NODE_PORT =  process.env.NODE_PORT
const NODE_USER =  process.env.NODE_USER
const NODE_PASSWORD =  process.env.NODE_PASSWORD
const UTXO_TRACKER_API_PORT = process.env.UTXO_TRACKER_API_PORT
const DB_NAME =  "xchain-utxo-tracker"
const AUX_POW = process.env.AUX_POW

var tasks = {}

async function startApi(){
    //Start the tracker
    const tracker = new XChainUtxoTracker(NETWORK, NODE_URL, NODE_PORT, NODE_USER, NODE_PASSWORD, DB_NAME, AUX_POW);
    tracker.start()

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
            let utxos = await tracker.getUtxosAddress(address)

            // Return utxos
            return { utxos: utxos}
        },
        // Function to retrieve the oldest tx of an address
        async get_oldest_tx({address}) {
            let oldestTx = await tracker.getOldestTransaction(address)

            // Return utxos
            return { oldest_tx: oldestTx}
        },
        
        async get_input_from_key_pattern({pattern}) {
            if (pattern.length < 32){
                return {error: "pattern is too short"}
            } else {
            
                let results = await db.getValuesFromKeyPattern(pattern)

                // Return utxos
                return { result: results}
            }
        },
        
        async getbootstrap({filename}){
            console.log("A bootstrap was requested")
            let taskId = randomUUID()
            await tracker.stopParsing()
            try {
                console.log("Compressing the data...")
                let destination = "/bootstrap/xchain-utxo-tracker/"+filename
                tasks[taskId] = {"progress": 0, "filename": filename}//, last_block_index":}
                compressDirPigz(taskId, "/data/"+DB_NAME, destination).then((finished) =>{
                    console.log("Starting the parsing again")
                    tracker.start()
                }).catch(error => {
                    console.log("Warning, compression was not succesful: "+error)
                    delete tasks[taskId]
                })
                
                return {"task_id":taskId}
            } catch (err){
                console.log("Warning compression was not succesful: "+err)
                delete tasks[taskId]
                return {error: err}
            }
        },
        
        async getbootstrapstatus({taskid}){
            if (taskid in tasks){
                return tasks[taskid]
            } else {
                return {error:"taskid doesn't exist"}
            }
        },
        
        async restorebootstrap({filename}){
            console.log("A bootstrap restore was requested")
            let taskId = randomUUID()
            await tracker.stopParsing()
            try {
                let source = "/bootstrap/xchain-utxo-tracker/"+filename
                tasks[taskId] = {"progress": 0, "filename": filename}
                decompressPigz(taskId, source, "/data/"+DB_NAME).then((finished) =>{
                    console.log("Starting the parsing")
                    tracker.start()
                }).catch(error => {
                    console.log("Warning, decompression was not succesful: "+error)
                    delete tasks[taskId]
                })
                
                return {"task_id":taskId}
            } catch (err){
                console.log("Warning decompression was not succesful: "+err)
                delete tasks[taskId]
                return {error: err}
            }
        },
        
        async getbootstraprestorestatus({taskid}){
            if (taskid in tasks){
                return tasks[taskid]
            } else {
                return {error:"taskid doesn't exist"}
            }
        }
    }

    // Allow JSON-RPC requests
    app.use(jsonRouter({methods: jsonRpcController}))


    // Start the server
    app.listen(UTXO_TRACKER_API_PORT, () => {
      console.log('API listening on port '+UTXO_TRACKER_API_PORT)
    })
}

async function compressDirPigz(taskId, source, destination) {
    tasks[taskId] = {progress: 0, filename: destination}
  
    // Calculate source size with du
    const duProcess = spawn('du', ['-sb', source])
    let totalBytesString = ''

    duProcess.stdout.on('data', (data) => {
        totalBytesString += data.toString()
    })

    await new Promise((resolve, reject) => {
        duProcess.on('close', (code) => {
            if (code !== 0) {
                return reject(new Error(`Error obtaining source size with "du" command with code ${code}`))
            }
            resolve()
        })
        duProcess.on('error', (err) => reject(new Error(`Error with du command: ${err.message}`)))
    })

    const totalBytes = parseInt(totalBytesString.split('\t')[0], 10)

    if (isNaN(totalBytes) || totalBytes <= 0) {
        console.error(`Error: Invalid size for source '${source}'.`)
        delete tasks[taskId]
        throw new Error(`Invalid size for source: ${totalBytes}`)
    }

    const tar = spawn('tar', ['-cf', '-', '-C', source, '.']) // -c: create, -f -: output to stdout
    const pv = spawn('pv', [
        '-s', totalBytes.toString(), // -s: expected total size,
        '-n', '-f' //-n: progress in number -f: force output
    ])   
    const pigz = spawn('pigz', ['-C', JSON.stringify({"original_size":totalBytes.toString()})]) //-C add a comment to the final file, this will be the original size to calculate progress when decompressing

    // Pipe all processes
    tar.stdout.pipe(pv.stdin) // tar sends data to pv
    pv.stdout.pipe(pigz.stdin)  // pv monitors data and sends it to pigz
    const outputStream = fs.createWriteStream(destination)
    pigz.stdout.pipe(outputStream) // pigz sends compress data to file

    // Monitors stderr from pv
    pv.stderr.on('data', (data) => {
        // handling pv progress
        const percentageString = data.toString().trim(); // pv -n prints the progress and a line break
        const currentPercentage = parseInt(percentageString, 10);
        
        if (!isNaN(currentPercentage)) { // Check if the percentage is a valid number
            tasks[taskId]["progress"] = currentPercentage
        }
    })

    // Error handling and finishing processes
    return new Promise((resolve, reject) => {
        let tarError = null
        let pvError = null
        let pigzError = null

        tar.on('close', (code) => {
            if (code !== 0) tarError = new Error(`tar throwed an error with código ${code}`)
        })
        pv.on('close', (code) => {
            if (code !== 0) pvError = new Error(`pv throwed an error with código ${code}`)
        })
        pigz.on('close', (code) => {
            if (code !== 0) pigzError = new Error(`pigz throwed an error with código ${code}`)

            // If there is an error reject the whole process
            if (tarError || pvError || pigzError) {
                reject(tarError || pvError || pigzError)
            } else {
                //console.log(`\nProcess completed. File: ${destination}`)
                resolve(destination)
            }
        })

        // Handling init errors
        tar.on('error', (err) => reject(new Error(`tar failed to init: ${err.message}`)))
        pv.on('error', (err) => reject(new Error(`pv failed to init: ${err.message}`)))
        pigz.on('error', (err) => reject(new Error(`pigz fail to init: ${err.message}`)))
    })
}

async function getGzipJsonMetadata(filePath) {
    return new Promise((resolve, reject) => {
        // Search for a line that starts with "{" and ends with "}"
        const command = `head -c 65K "${filePath}" | strings | grep -oE '^\\{.*\\}$' | head -n 1`

        exec(command, { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
            if (error) {
                // An error could mean that no JSON was found
                resolve(null)
                return
            }
            const jsonString = stdout.trim()
            if (jsonString) {
                try {
                    const metadata = JSON.parse(jsonString)
                    resolve(metadata)
                } catch (parseError) {
                    console.error(`Error parsing the JSON found: ${parseError.message}`)
                    resolve(null)
                }
            } else {
                resolve(null)
            }
        })
    })
}


async function decompressPigz(taskId, source, destination) {
    console.log("Deleting data directory")
    deleteFilesInDirectorySync(destination)
    //fs.mkdirSync(destination, { recursive: true })
    console.log("Decompressing the data...")
                
    // Read the comment in the GZIP file
    const comment = await getGzipJsonMetadata(source)
    let totalUncompressedBytes = null
    
    if (comment) {
        try {
            totalUncompressedBytes = comment["original_size"]
        } catch(err) {
            console.warn("WARNING: Couldn't find a valid metadata in the compressed file. There will be no progress to show.")
        }
    } else {
        console.warn("WARNING: Couldn't find any metadata in the compressed file. There will be no progress to show.")
    }

    console.log(`Decompressing from "${source}" to "${destination}"...`)

    // Execute pigz -d -> pv -> tar -x
    const pigz = spawn('pigz', ['-d', '-c', source])

    const pvArgs = ['-n', '-f']
    if (totalUncompressedBytes !== null) {
        pvArgs.unshift('-s', totalUncompressedBytes.toString()) // Add -s only if the size is valid
    }
    const pv = spawn('pv', pvArgs)
    const tar = spawn('tar', ['-x', '-f', '-', '-C', destination])

    // Connect the processes
    pigz.stdout.pipe(pv.stdin)
    pv.stdout.pipe(tar.stdin)

    let lastReportedValue = -1
    pv.stderr.on('data', (data) => {
        // handling pv progress
        const percentageString = data.toString().trim(); // pv -n prints the progress and a line break
        const currentPercentage = parseInt(percentageString, 10);
        
        if (!isNaN(currentPercentage)) { // Check if the percentage is a valid number
            tasks[taskId]["progress"] = currentPercentage
        }
    })

    // Handling errors
    pigz.stderr.on('data', (data) => { console.error(`Error from pigz: ${data}`) })
    tar.stderr.on('data', (data) => { console.error(`Error from tar: ${data}`) })

    return new Promise((resolve, reject) => {
        let pigzError = null
        let pvError = null
        let tarError = null

        pigz.on('close', (code) => {
            if (code !== 0) pigzError = new Error(`pigz exited with code ${code}`)
        })
        pv.on('close', (code) => { 
            if (code !== 0) pvError = new Error(`pv exited with code ${code}`)
        })
        tar.on('close', (code) => {
            if (code !== 0) tarError = new Error(`tar exited with code ${code}`)

            if (pigzError || pvError || tarError) {
                reject(pigzError || pvError || tarError);
            } else {
                console.log(`Process completed. Dir "${destination}".`);
                resolve(destination)
            }
        })

        pigz.on('error', (err) => reject(new Error(`pigz fail to init: ${err.message}`)));
        pv.on('error', (err) => reject(new Error(`pv failed to init: ${err.message}`)));
        tar.on('error', (err) => reject(new Error(`tar failed to init: ${err.message}`)));
    })
}

function deleteFilesInDirectorySync(directoryPath) {
    try {
        const files = fs.readdirSync(directoryPath, { withFileTypes: true })

        for (const file of files) {
            const filePath = path.join(directoryPath, file.name)
            if (file.isDirectory()) {
                fs.rmSync(filePath, { recursive: true })
            } else {
                fs.rmSync(filePath)
            }
        }
    } catch (err) {
        console.log(err)
        throw new Error(`Error trying to delete the content of ${directoryPath}:`, err)
    }
}

startApi()