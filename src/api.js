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
 * XChain UTXO Tracker - API
 * 
 * This file parses in environmental variables and starts up the utxo tracker instance
 * 
 ********************************************************************/

// Load required libraries
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
const BlockchainConnector = require('./BlockchainConnector');
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
const AUX_POW = process.env.AUX_POW === 'true' || process.env.AUX_POW === '1'

// Bulk-sync pre-flight (activates on empty DB). See runBulkSyncIfEmpty below.
const BULK_SYNC_WORKERS      = process.env.BULK_SYNC_WORKERS      || '6'
const BULK_SYNC_CHUNK_SIZE   = process.env.BULK_SYNC_CHUNK_SIZE   || '10000'
const BULK_SYNC_RAM_BUDGET   = process.env.BULK_SYNC_RAM_BUDGET   || '4096'
const BULK_SYNC_TIP_SAFETY   = process.env.BULK_SYNC_TIP_SAFETY   || '10'
const BULK_SYNC_BATCH_SIZE   = process.env.BULK_SYNC_BATCH_SIZE   || '10000'
const BULK_SYNC_WORK_DIR     = process.env.BULK_SYNC_WORK_DIR     || path.join('/data', DB_NAME, '_bulk-sync-work')
const BULK_SYNC_NODE_POLL_MS = 30000

var tasks = {}

async function startApi(){
    //Start the tracker
    const tracker = new XChainUtxoTracker(NETWORK, NODE_URL, NODE_PORT, NODE_USER, NODE_PASSWORD, DB_NAME, AUX_POW);
    tracker.start()

    async function getUtxos(address){
        let utxos = await tracker.getUtxosAddress(address)
        return utxos
    }

    async function getFirstSeen(address){
        return await tracker.getFirstSeen(address)
    }
    
    async function getBalance(address){
        let utxos = await tracker.getUtxosAddress(address)
        let balance = 0

        for (let nextUtxo of utxos){
            balance = balance + nextUtxo.amount
        }

        // Return balance
        return balance
    }
    
    async function getInfo(address){
        let infoAddress = await tracker.getBalanceInfo(address)

        return infoAddress
    }

    // Create the app
    const app = express();

    // Use Helmet to increase security
    app.use(helmet());

    // Allow JSON requests
    app.use(bodyParser.json());

    // Allow CORS for development
    app.use(cors());

    app.get('/utxos/:address', async (req, res) => {
        const address = req.params.address;
        const utxos = await getUtxos(address);
        // Signal mempool readiness so callers can distinguish a genuinely empty
        // result from one served before the in-memory mempool has reconverged
        // after a restart. Body shape (a bare array) is left unchanged.
        res.set('X-Mempool-Ready', String(tracker.isSynced()));
        res.send(utxos);
    })

    app.get('/firstseen/:address', async (req, res) => {
        const address = req.params.address;
        const firstSeen = await getFirstSeen(address);
        res.send(firstSeen);
    })

    app.get('/balance/:address', async (req, res) => {
        const address = req.params.address;
        const balance = await getBalance(address);
        // See /utxos above: expose mempool readiness via header without altering
        // the existing bare-number body.
        res.set('X-Mempool-Ready', String(tracker.isSynced()));
        res.send(balance);
    })

    app.get('/info/:address', async (req, res) => {
        const address = req.params.address;
        const info = await getInfo(address);
        // info is a JSON object, so expose readiness both in-body (additive
        // field) and via header. A false value means the in-memory mempool is
        // still reconverging after a restart and `balances.pending` may be
        // understated — callers should not treat pending=0 as authoritative yet.
        const mempoolReady = tracker.isSynced();
        res.set('X-Mempool-Ready', String(mempoolReady));
        if (info && typeof info === 'object') info.mempool_ready = mempoolReady;
        res.send(info);
    })

    const jsonRpcController = {

        // Function to check if xchain-utxo-tracker is up
        async ping() {
            return {status:"success"};
        },

        // ── Readiness contract ─────────────────────────────────────────
        // The tracker's height fields all report the LAST COMMITTED state,
        // not in-flight processing. This matters because the tracker buffers
        // up to DB_TRANSACTION_BLOCKS_QUANTITY blocks before flushing via
        // endTransaction(). During a mid-batch state, in-memory has the new
        // UTXOs but disk doesn't — and getLastBlockHeight() reads from disk.
        // So getLastBlockHeight() returning N is a hard guarantee that every
        // output in blocks 0..N is queryable via get_utxos / get_balance.
        // is_quiescent() builds on this: it returns ready=true only when the
        // committed height matches the node tip AND the node's mempool is
        // empty, giving callers a barrier they can wait on without needing
        // to know any of the tracker's batching internals.
        // ───────────────────────────────────────────────────────────────

        // Sync-status probe: tracker tip vs node tip. Used by e2e tests and
        // ops tooling to diagnose lag when an address's funding tx looks lost.
        // `tracker_height` and `committed_height` are aliases — both report
        // the last committed block. `committed_height` is the canonical name
        // going forward; `tracker_height` retained for existing callers.
        async get_sync_status() {
            let committedHeight = -1;
            try { committedHeight = await tracker.db.getLastBlockHeight(); } catch (e) {}

            let nodeHeight = -1;
            let nodeHeightStale = false;
            try {
                const info = await tracker.connector.getBlockchainInfo();
                nodeHeight = info['blocks'];
            } catch (e) {
                const rawTip = tracker.latestKnownChainTip ?? tracker.blockchainInfoLastBlock;
                nodeHeight = (typeof rawTip === 'number') ? rawTip : -1;
                nodeHeightStale = true;
            }

            const lag = (nodeHeight >= 0 && committedHeight >= 0) ? (nodeHeight - committedHeight) : null;
            const result = {
                committed_height: committedHeight,
                tracker_height:   committedHeight,
                node_height:      nodeHeight,
                lag:              lag,
                // Authoritative sync verdict computed against the tracker's own
                // SYNCED_THRESHOLD so callers don't replicate the threshold.
                // null lag (nothing indexed yet) is never "synced".
                synced:           lag !== null && lag <= XChainUtxoTracker.SYNCED_THRESHOLD
            };
            if (nodeHeightStale) result.node_height_stale = true;
            return result;
        },

        // Quiescence probe: returns ready=true iff every previously-broadcast
        // tx is mined-and-indexed AND the tracker has no in-flight batch.
        // Test framework barrier — callers can poll this between e2e tests so
        // the next test starts from a fully-settled stack instead of inheriting
        // hidden state (unflushed batch, mempool backlog) that caused
        // ordering-dependent flakes.
        //
        // Conditions:
        //   1. node-side mempool is empty (no unmined txs the tracker is
        //      blind to until the next MEMPOOL_INTERVAL poll)
        //   2. node tip == tracker's last-committed height (setLastBlockHeight
        //      only commits via endTransaction, so this naturally returns
        //      false during a mid-batch state)
        async is_quiescent() {
            let mempoolSize = -1;
            let trackerHeight = -1;
            let nodeHeight = -1;
            try {
                const mempool = await tracker.connector.getRawMempool();
                mempoolSize = Array.isArray(mempool) ? mempool.length
                            : (mempool && typeof mempool === 'object') ? Object.keys(mempool).length
                            : 0;
            } catch (e) { /* leave -1; caller treats as not-ready */ }
            try { trackerHeight = await tracker.db.getLastBlockHeight(); } catch (e) {}
            try {
                const info = await tracker.connector.getBlockchainInfo();
                nodeHeight = (info && typeof info.blocks === 'number') ? info.blocks : -1;
            } catch (e) {}
            const heightAligned = (nodeHeight >= 0 && trackerHeight >= 0 && nodeHeight === trackerHeight);
            const mempoolEmpty  = (mempoolSize === 0);
            return {
                ready:            heightAligned && mempoolEmpty,
                mempool_size:     mempoolSize,
                committed_height: trackerHeight,
                tracker_height:   trackerHeight,
                node_height:      nodeHeight,
                lag:              (nodeHeight >= 0 && trackerHeight >= 0) ? (nodeHeight - trackerHeight) : null
            };
        },

        // Function to create transactions hex for a given data and encoding type
        async get_utxos({address}) {
            let utxos = await getUtxos(address)

            // Return utxos
            return { utxos: utxos}
        },
        // Function to retrieve the height of the block where an address was first seen
        async get_first_seen({address}) {
            return await getFirstSeen(address)
        },
        
        async get_balance({address}) {
            let balance = await getBalance(address)

            // Return balance
            return { balance: balance}
        },
        
        // Function to retrieve the confirmed, pending balances of an address
        async get_info({address}) {
            return await getInfo(address)
        },
        
        async get_input_from_key_pattern({pattern}) {
            if (pattern.length < 32){
                return {error: "pattern is too short"}
            } else {
            
                let results = await tracker.db.getValuesFromKeyPattern(pattern)

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
                    tasks[taskId]["progress"] = 100
                    console.log("Starting the parsing again")
                    tracker.start()
                }).catch(error => {
                    tasks[taskId]["progress"] = -1
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
                    tasks[taskId]["progress"] = 100
                    console.log("Starting the parsing")
                    tracker.start()
                }).catch(error => {
                    tasks[taskId]["progress"] = -1
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

async function isDbEmpty() {
    const store = new LevelUpStore(DB_NAME)
    try {
        await store.createDatabase()
        const h = await store.getLastBlockHeight()
        return h < 0
    } finally {
        try { await store.close() } catch (_) {}
    }
}

async function waitForNodeSynced() {
    const connector = new BlockchainConnector(NODE_URL, NODE_PORT, NODE_USER, NODE_PASSWORD)
    console.log('[bulk-sync] waiting for coin node to finish IBD...')
    for (;;) {
        try {
            const info = await connector.getBlockchainInfo()
            const lag = info.headers - info.blocks
            if (lag <= 5) {
                console.log(`[bulk-sync] node synced: blocks=${info.blocks} headers=${info.headers}`)
                return
            }
            console.log(`[bulk-sync] node lag=${lag} (blocks=${info.blocks}/headers=${info.headers})`)
        } catch (err) {
            console.log(`[bulk-sync] node not reachable yet: ${err.message}`)
        }
        await new Promise(r => setTimeout(r, BULK_SYNC_NODE_POLL_MS))
    }
}

function runBulkSyncOrchestrator() {
    const dbPath   = path.join('/data', DB_NAME)
    const orchPath = path.join(__dirname, 'bulk-sync', 'orchestrator.js')

    const args = [
        orchPath,
        '--network',    NETWORK,
        '--from',       '0',
        '--tip-safety', BULK_SYNC_TIP_SAFETY,
        '--chunk-size', BULK_SYNC_CHUNK_SIZE,
        '--workers',    BULK_SYNC_WORKERS,
        '--out',        BULK_SYNC_WORK_DIR,
        '--db',         dbPath,
        '--ram-budget', BULK_SYNC_RAM_BUDGET,
        '--batch-size', BULK_SYNC_BATCH_SIZE,
    ]

    // Resume support: if parsed/ already has worker output, skip dump+parse.
    const parsedDir = path.join(BULK_SYNC_WORK_DIR, 'parsed')
    if (fs.existsSync(parsedDir) && fs.readdirSync(parsedDir).some(f => f.endsWith('.dat'))) {
        console.log('[bulk-sync] detected existing parsed/ — adding --skip-parse')
        args.push('--skip-parse')
    }

    console.log('[bulk-sync] spawning orchestrator:', ['node', ...args].join(' '))

    return new Promise((resolve, reject) => {
        const child = spawn('node', args, { stdio: 'inherit', env: process.env })
        child.on('exit', (code) => {
            if (code === 0) resolve()
            else reject(new Error(`orchestrator exited with code ${code}`))
        })
        child.on('error', reject)
    })
}

async function runBulkSyncIfEmpty() {
    if (!(await isDbEmpty())) {
        return
    }
    console.log(`[bulk-sync] DB '${DB_NAME}' is empty — triggering bulk-sync pipeline`)
    await waitForNodeSynced()

    // bulk-sync requires at least tipSafety+1 blocks. On fresh regtest stacks
    // (or any chain that hasn't reached coinbase maturity yet) the node reports
    // headers==blocks==0 — waitForNodeSynced returns immediately, then dump.js
    // FATALs with "computed dump end (tip=0 - safety=10) is before --from=0".
    // Skip the pipeline and let the normal incremental tracker handle it.
    const connector = new BlockchainConnector(NODE_URL, NODE_PORT, NODE_USER, NODE_PASSWORD)
    const info      = await connector.getBlockchainInfo()
    const minBlocks = parseInt(BULK_SYNC_TIP_SAFETY, 10) + 1
    if (info.blocks < minBlocks) {
        console.log(`[bulk-sync] chain too short (${info.blocks} blocks < ${minBlocks} required) — skipping bulk-sync, incremental sync will index from block 0`)
        return
    }

    await runBulkSyncOrchestrator()
    try {
        fs.rmSync(BULK_SYNC_WORK_DIR, { recursive: true, force: true })
        console.log(`[bulk-sync] work dir ${BULK_SYNC_WORK_DIR} removed after successful load`)
    } catch (err) {
        console.warn(`[bulk-sync] cleanup warning: ${err.message}`)
    }
}

runBulkSyncIfEmpty()
    .then(() => startApi())
    .catch(err => {
        console.error('[fatal]', err.message)
        if (err.stack) console.error(err.stack)
        process.exit(1)
    })