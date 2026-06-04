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
const BLOCKCHAIN_INFO_REFRESH_MS = 30000 //Re-poll the node tip at least this often during catch-up so the tracked tip stays current
const DB_TRANSACTION_BLOCKS_QUANTITY = 200
// Heap-pressure flush guard: modern BTC blocks (~4k tx avg, 10k+ in dense
// windows) accumulate ~17–90 MB of staged Buffer writes per block in
// `transactionArray`. A full 200-block batch can push V8 heap past the
// 4 GB --max-old-space-size cap mid-parse and abort the process. Flush
// early when heap exceeds this threshold so the block-count constant
// acts as an upper bound rather than the sole trigger.
const HEAP_FLUSH_THRESHOLD_MB = 2048
const PARSE_MODE_FILES = 0
const PARSE_MODE_BULK_INSERTS = 1
const SYNCED_THRESHOLD = 3
const SATOSHI_UNIT = 100000000.0
const SATOSHI_BIGINT = 100000000n

// Exact satoshi -> decimal-string conversion. Plain float division (value / 1e8)
// loses precision once a total exceeds Number.MAX_SAFE_INTEGER (e.g. DOGE balances
// above ~90M), so all balance/amount formatting goes through this BigInt path.
function satoshiToDecimalString(satoshis) {
    const val = BigInt(satoshis)
    const abs = val < 0n ? -val : val
    const whole = abs / SATOSHI_BIGINT
    const frac = abs % SATOSHI_BIGINT
    return (val < 0n ? '-' : '') + whole.toString() + '.' + frac.toString().padStart(8, '0')
}
const MEMPOOL_INTERVAL = 60000
const MEMPOOL_BATCH_SIZE = 1000
// Breathing room between mempool batches (CPU/IO). Kept small so the cumulative
// inter-batch sleep stays well under MEMPOOL_INTERVAL even for large mempools
// (e.g. 50k txs => 49 sleeps => ~73.5s of sleep at 1500ms, vs ~490s at 10s),
// which previously kept mempoolBusy locked across every interval tick and left
// pending-balance queries stale for the whole multi-batch window.
const MEMPOOL_INTER_BATCH_SLEEP = 1500
// Max consecutive getRawTransactions failures before we abandon this mempool
// pass. The node going down mid-pass would otherwise spin this retry loop
// forever, never reaching the outer finally that clears the busy flag.
const MEMPOOL_MAX_TX_FETCH_RETRIES = 5
const REMOVE_SPENT = true
const ETA_WINDOW_BLOCKS = 1000 //Rolling window size for ETA calculation
const MIN_VERIFICATION_PROGRESS_TO_PARSE = 0.99 //How much progress the node need to have to start parsing

// Per-chain reorg recovery window (Tier B, 2026-06-02): how many recent blocks of
// spent-output recovery records (K/M entries) are retained, and therefore the
// deepest reorg the tracker can auto-recover from before a manual resync is
// required. Sized larger on the faster / lower-hashpower chains so the window
// stays comfortably above that chain's cross-chain confirmation gate (an ordinary
// reorg inside the trust window is auto-recovered, never a manual resync). On
// 1-minute DOGE blocks the old flat value of 10 was only ~10 minutes of headroom.
const DEFAULT_UNDO_BLOCKS = { BTC: 12, LTC: 48, DOGE: 120 }
const FALLBACK_UNDO_BLOCKS = 12

// Map a network string ('dogecoin-mainnet', 'litecoin-testnet', ...) to its coin.
function coinFromNetwork(network){
    const n = String(network || '').toLowerCase()
    if (n.startsWith('bitcoin'))  return 'BTC'
    if (n.startsWith('litecoin')) return 'LTC'
    if (n.startsWith('dogecoin')) return 'DOGE'
    return null
}

// Resolve the recovery window: env XCHAIN_UNDO_BLOCKS_<COIN> → Tier-B per-chain
// default → fallback (mirrors the `process.env.X || default` style in api.js).
function resolveUndoBlocks(network){
    const coin = coinFromNetwork(network)
    const envKey = coin ? ('XCHAIN_UNDO_BLOCKS_' + coin) : ''
    return parseInt(process.env[envKey], 10) || DEFAULT_UNDO_BLOCKS[coin] || FALLBACK_UNDO_BLOCKS
}
const PREFETCH_SIZE = 10 //Number of blocks to pre-fetch concurrently while processing the current one

// Single-byte key used to persist pendingKMCleanup across restarts.
// 0x50 ('P') is unused by LevelUpDb's key schema (B/T/I/O/H/J/S/Z/K/M/N).
const P_PENDING_CLEANUP_KEY = Buffer.from([0x50])

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
      this.latestKnownChainTip = null
      this.mempoolInterval = null
      this.mempoolBusy = false
      
      this.auxPow = auxPow
      this.undoBlocks = resolveUndoBlocks(network)
      this.lastBlocks = []
      
      this.keepParsing = true
      this.pendingKMCleanup = []
    }
    
    async addToLastBlocks(blockHash){
        this.lastBlocks.push(blockHash)
        this.db.addLastStoredBlock(blockHash)

        while (this.lastBlocks.length > this.undoBlocks){
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

        // Remove the crash-recovery marker atomically with the cleanup writes so
        // a crash here causes a harmless idempotent re-run on the next restart.
        await this.db.addTransaction("del", P_PENDING_CLEANUP_KEY)

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

    // getLastStoredBlocks() returns the stored-block hashes in blockHash
    // (lexicographic) order, but the reorg path (removeFromLastBlocks) requires
    // lastBlocks to be in ascending HEIGHT order with the chain tip last.
    // Without sorting, a reorg throws "Can't delete a block from the 'last
    // blocks'…" and wedges the sync loop. Each block's height comes from its
    // B-prefix record; this is at most UNDO_BLOCKS (10) lookups.
    async loadLastBlocksSortedByHeight(){
        const storedHashes = await this.db.getLastStoredBlocks()
        const withHeight = []
        for (const hash of storedHashes){
            const blk = await this.db.getBlock(hash)
            withHeight.push({ hash, height: blk ? blk.h : -1 })
        }
        withHeight.sort((a, b) => a.height - b.height)
        return withHeight.map(b => b.hash)
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

            if (this.mempoolInterval) {
                clearInterval(this.mempoolInterval)
                this.mempoolInterval = null
            }

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

        let confirmedBalance = 0n
        let pendingBalance = 0n
        let utxosConfirmed = 0
        let utxosPending = 0
        let totalReceived = 0n

        let confirmedOutputs = await this.db.getOutputsScriptPubKey(scriptHash)
        let mempoolOutputs = await this.mempoolDb.getOutputsScriptPubKey(scriptHash)

        for (let nextOutput of confirmedOutputs) {
            let txid = nextOutput.fullTxid || nextOutput.txid
            let amount = BigInt(nextOutput.value)

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
                pendingBalance += BigInt(nextOutput.value)
                utxosPending++
            }
        }

        return {
            "address": address,
            "type": this.getAddressType(address, this.network),
            "balances": {
                "confirmed": satoshiToDecimalString(confirmedBalance),
                "pending": satoshiToDecimalString(pendingBalance),
                "received": satoshiToDecimalString(totalReceived)
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

            // A valid txid is the full 32-byte hash (64 hex chars). When fullTxid
            // is null the fallback yields the 8-byte O-key prefix (16 hex chars) —
            // which happens only for O-records written before the full hash was
            // added to the O-record format. Such a record can never produce a
            // valid spend, so fail loudly here rather than letting the truncated
            // id silently corrupt a downstream PSBT. Re-index this LevelDB.
            if (txid.length !== 64) {
                throw new Error(
                    `UTXO record is missing a fullTxHash (got ${txid.length}-char key prefix instead of a 64-char txid).` +
                    ` This record predates the O-record fullTxHash field — re-index this LevelDB before use.` +
                    ` UTXO key: ${nextOutput.txid}`
                )
            }

            // Skip confirmed outputs being spent in the mempool
            let mempoolInput = await this.mempoolDb.getInput(txid, nextOutput.vout)
            if (mempoolInput != null) continue

            nextOutput.txid = txid
            nextOutput.confirmations = this.blockchainInfoLastBlock - nextOutput.height + 1
            nextOutput.amount = satoshiToDecimalString(nextOutput.value)
            nextOutput.scriptPubKey = scriptPubKeyHex
            results.push(nextOutput)
        }

        for (let nextOutput of mempoolOutputs) {
            let txid = nextOutput.fullTxid || nextOutput.txid

            // See the confirmed-output loop above: a 16-char fallback means the
            // O-record predates the fullTxHash field and can never spend validly.
            if (txid.length !== 64) {
                throw new Error(
                    `UTXO record is missing a fullTxHash (got ${txid.length}-char key prefix instead of a 64-char txid).` +
                    ` This record predates the O-record fullTxHash field — re-index this LevelDB before use.` +
                    ` UTXO key: ${nextOutput.txid}`
                )
            }

            // Skip mempool outputs that are also spent by another mempool tx
            let mempoolInput = await this.mempoolDb.getInput(txid, nextOutput.vout)
            if (mempoolInput != null) continue

            nextOutput.txid = txid
            nextOutput.height = null
            nextOutput.confirmations = 0
            nextOutput.amount = satoshiToDecimalString(nextOutput.value)
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

            // Reverse the wire-order (little-endian) hash to big-endian display
            // order on a COPY of the buffer. .reverse() mutates in place, and
            // nextInput.hash is shared: the same decoded tx can be parsed again
            // on a later path (e.g. mempool ingest, then block confirmation).
            // Mutating it here would (a) double-reverse within this call,
            // corrupting the hint record's prevTxHash, and (b) leave the buffer
            // flipped for the downstream re-parse, breaking its spend lookup.
            // Buffer.from() copies, so the source bytes stay untouched and the
            // same hex feeds insertInput, the hint, and the removeSpent lookup.
            const prevTxHashHex = util.uint8ArrayToHex(Buffer.from(nextInput.hash).reverse())

            if (removeSpent){
                let prevTxHash8 = prevTxHashHex.substring(0, 16)
                await db.removeOutputWithInput({prevTxHash:prevTxHash8, prevOutputIndex:nextInput.index, blockHash:blockHash})
            } else {
                await db.insertInput({
                    prevTxHash:prevTxHashHex,
                    prevOutputIndex:nextInput.index,
                    txHash:nextTxId8
                })
            }

            if (addHints){
                await db.insertInputHint({
                    prevTxHash:prevTxHashHex,
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
                await db.insertOutputBlock({scriptPubKey:scriptHash, txHash:nextTxId8, outputIndex:txOutputIndex, blockHash})
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

                await db.insertOutputBlock({scriptPubKey: scriptHash, txHash: nextTxId8, outputIndex: txOutputIndex, blockHash})
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

            // Reverse the wire-order (little-endian) hash to big-endian display
            // order on a COPY of the buffer. .reverse() mutates in place, and
            // nextInput.hash is shared: the same decoded tx can be parsed again
            // on a later path (e.g. mempool ingest, then block confirmation).
            // Mutating it here would (a) double-reverse within this call,
            // corrupting the hint record's prevTxHash, and (b) leave the buffer
            // flipped for the downstream re-parse, breaking its spend lookup.
            // Buffer.from() copies, so the source bytes stay untouched and the
            // same hex feeds insertInput, the hint, and the removeSpent lookup.
            const prevTxHashHex = util.uint8ArrayToHex(Buffer.from(nextInput.hash).reverse())

            if (removeSpent) {
                const prevTxHash8 = prevTxHashHex.substring(0, 16)
                await db.removeOutputWithInput({prevTxHash: prevTxHash8, prevOutputIndex: nextInput.index, blockHash: blockHash})
            } else {
                await db.insertInput({
                    prevTxHash: prevTxHashHex,
                    prevOutputIndex: nextInput.index,
                    txHash: nextTxId8
                })
            }

            if (addHints) {
                await db.insertInputHint({
                    prevTxHash: prevTxHashHex,
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
        let retryCount = 0

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
                    console.error('Error fetching block hash from node: ' + err.message, err)
                    await this.sleep(3000)
                    continue
                }
                
                console.log("Last block hash from node is "+blockHashFromNode)
                
                if (lastBlockHash != blockHashFromNode){
                    // Depth guard: spent-output recovery records (K/M entries) are
                    // retained only for the most recent UNDO_BLOCKS blocks —
                    // cleanupAgedBlocks() purges them once a block ages out of that
                    // window. Once we have already rolled back UNDO_BLOCKS blocks, the
                    // next block's recovery records are gone, so processDeletedOutputs(
                    // hash, true) would silently restore nothing and leave the UTXO
                    // index permanently under-counted for any address with outputs spent
                    // in those blocks. A loud abort is strictly safer than a silently
                    // corrupt index: stop here and require an operator-driven resync.
                    if (blocksDeleted.length >= this.undoBlocks){
                        const msg = "verifyReorg: reorg depth exceeds the recovery window "
                            + "(UNDO_BLOCKS=" + this.undoBlocks + "). Already rolled back "
                            + blocksDeleted.length + " blocks; spent-output recovery records "
                            + "for block height " + lastBlockIndex + " and below have already "
                            + "been purged, so continuing would silently leave the UTXO index "
                            + "under-counted. Aborting. Recovery: perform a full resync from a "
                            + "known-good snapshot."
                        console.error(msg)
                        throw new Error(msg)
                    }
                    try {
                        await this.db.beginTransaction()
                        if (REMOVE_SPENT){
                            await this.db.removeOutputScriptsInBlock(lastBlockHash)
                            await this.db.processDeletedOutputs(lastBlockHash, true)
                            // Purge outputs created in the rolled-back block that were
                            // never spent — processDeletedOutputs only restores outputs
                            // spent in it. Runs last so any output both created and spent
                            // in this block (just re-staged above) is removed, not revived.
                            await this.db.removeCreatedOutputsInBlock(lastBlockHash)
                        }
                        await this.db.deleteBlock(lastBlockHash)
                        await this.removeFromLastBlocks(lastBlockHash)
                        await this.db.setLastBlockHash(lastBlock["ph"])
                        await this.db.setLastBlockHeight(lastBlock["h"]-1)
                        await this.db.endTransaction()

                        console.log("Removed block "+lastBlockHash+" ("+lastBlock["h"]+")")
                        console.log("Rollback to previous block "+lastBlock["ph"]+" ("+(lastBlock["h"]-1)+")")

                        // Per-block retry budget: reset after each successful rollback so the
                        // 10-attempt limit applies per block, not cumulatively across the whole
                        // reorg run. Otherwise a multi-block reorg with one transient failure per
                        // block could exhaust the budget and abort, leaving orphan blocks behind.
                        retryCount = 0
                        blocksDeleted.push({"block_index":lastBlockIndex, "block_hash":lastBlockHash})
                    } catch (err){
                        try { await this.db.endTransaction(false) } catch (_) {}
                        console.log(err)
                        console.log("There was a problem trying to delete a block while verifying a reorg", err)
                        if (++retryCount >= 10) throw new Error('verifyReorg: deleteBlockByIndex failed after 10 attempts, aborting')
                        await this.sleep(3000); continue
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

        // Load in ascending height order (tip last) so a reorg right after a
        // restart doesn't trip removeFromLastBlocks. See helper for detail.
        this.lastBlocks = await this.loadLastBlocksSortedByHeight()

        // Recover any K/M cleanup work that was staged but not completed before a prior crash.
        // abstract-level .get returns undefined on a missing key (no throw); real
        // I/O errors still propagate.
        const pVal = await this.db.db.get(P_PENDING_CLEANUP_KEY)
        if (pVal !== undefined) {
            this.pendingKMCleanup = JSON.parse(pVal.toString())
            if (this.pendingKMCleanup.length > 0) {
                console.log(`Recovering ${this.pendingKMCleanup.length} pending K/M cleanup block(s) from prior crash`)
            }
        }

        let lastBlockchainInfo = null
        let lastBlockchainInfoRefreshAt = 0
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
                // AuxPoW: one batch HTTP request each for getblockhash + getblockheader + getblock,
                // stripping the AuxPoW header bytes per block (getBlocksBatchWithoutAuxPow)
                const batchPromise = this.connector.getBlocksBatchWithoutAuxPow(heights)
                heights.forEach((h, i) => {
                    const p = batchPromise.then(results => ({ hash: results[i].hash, hex: results[i].hex }))
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
                //Getting the last block from the blockchain.
                //Refresh when we have no info yet, when we have caught up to the
                //previously-seen tip, OR periodically on a wall-clock interval — the
                //last condition keeps blockchainInfoLastBlock tracking the live chain
                //during a long catch-up, so the synced flag and reported confirmations
                //reflect the true chain tip instead of a frozen startup value.
                if (!lastBlockchainInfo
                    || (lastProcessedBlockIndex >= this.blockchainInfoLastBlock)
                    || (Date.now() - lastBlockchainInfoRefreshAt >= BLOCKCHAIN_INFO_REFRESH_MS)){
                    try {
                        lastBlockchainInfo = await this.connector.getBlockchainInfo()
                        this.latestKnownChainTip = lastBlockchainInfo["blocks"]

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
                        lastBlockchainInfoRefreshAt = Date.now()
                    } catch (e){
                        console.error('Error fetching blockchain info from node: ' + e.message, e)
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
                        console.error('Error fetching block at height ' + nextBlockHeight + ': ' + e.message, e)
                        await this.sleep(3000)
                        continue
                    }
                    
                    const _tDecode = Date.now()
                    var block = this.xchainBlockDecoder.blockFromHex(nextBlockHex)
                    let previousBlockHash = util.uint8ArrayToHex(Buffer.from(block.prevHash).reverse())
                    _t.decode += Date.now() - _tDecode

                    //Check if there is a reorg
                    if (nextBlockHeight > 0){
                        //previousBlockHash is not the same, it must be a reorg 
                        if (previousBlockHash != lastProcessedBlockHash){
                            prefetchQueue = []
                            await this.db.endTransaction(false)
                            // The rolled-back batch discarded the P-key write that
                            // records aged-out blocks awaiting K/M cleanup, but those
                            // blocks are too old to reorg and still need cleaning.
                            // Persist the list with a standalone put on the underlying
                            // store — deliberately outside the transaction just rolled
                            // back — so the startup recovery path runs cleanupAgedBlocks()
                            // for them on the next restart instead of stranding the
                            // entries on disk.
                            if (this.pendingKMCleanup.length > 0) {
                                await this.db.db.put(P_PENDING_CLEANUP_KEY,
                                    Buffer.from(JSON.stringify(this.pendingKMCleanup)))
                            }
                            // Reload in ascending height order (tip last); the raw
                            // getLastStoredBlocks() order is lexicographic by hash,
                            // which makes verifyReorg's removeFromLastBlocks throw.
                            this.lastBlocks = await this.loadLastBlocksSortedByHeight()
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
                            const prevTxHash8 = util.uint8ArrayToHex(Buffer.from(nextInput.hash).reverse()).substring(0, 16)
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
                    // Commit the whole block's mempool-cleanup deletions as one
                    // atomic batch. deleteOutputsByHint/deleteInputsByHint use
                    // per-entry `for await` read streams that yield to the event
                    // loop, so without a wrapping transaction a concurrent
                    // updateMempool() could split these deletions across its
                    // batch and direct writes, briefly exposing a half-removed
                    // (output gone, hint not yet) view to balance queries.
                    //
                    // beginTransaction()/endTransaction() share a single
                    // transactionArray slot with updateMempool(), so we must not
                    // open a second transaction while a mempool update owns it —
                    // doing so would orphan its batch and crash its endTransaction
                    // on a nulled array. mempoolBusy is the existing mutex: wait
                    // for any in-flight update to release it, then claim it for
                    // the cleanup. updateMempool() already tolerates a busy tick
                    // by skipping and retrying on the next interval.
                    while (this.mempoolBusy){
                        await this.sleep(50)
                    }
                    this.mempoolBusy = true
                    try {
                        await this.mempoolDb.beginTransaction()
                        for (const tx of transactions) {
                            const txid = "id" in tx ? tx["id"] : tx.getId()
                            await this.mempoolDb.deleteOutputsByHint(txid)
                            await this.mempoolDb.deleteInputsByHint(txid)
                            await this.mempoolDb.deleteTransaction(txid)
                        }
                        await this.mempoolDb.endTransaction()
                    } finally {
                        this.mempoolBusy = false
                    }

                    //Add the block to the last blocks
                    await this.addToLastBlocks(nextBlockHash)
                    
                    //If there are enough processed blocks, then add them to the database.
                    //Three triggers: batch full, at chain tip, or heap under pressure.
                    //Heap-pressure flush keeps the block-count constant working as an
                    //upper bound while preventing V8 OOM on dense chain windows where a
                    //full 200-block batch would push staged Buffers past the heap cap.
                    const _earlyFlushHeapMB = process.memoryUsage().heapUsed / 1048576
                    const _flushReason =
                        (nextBlockHeight == this.blockchainInfoLastBlock)             ? 'tip' :
                        (blocksQuantity == DB_TRANSACTION_BLOCKS_QUANTITY-1)          ? 'batch-full' :
                        (_earlyFlushHeapMB > HEAP_FLUSH_THRESHOLD_MB)                 ? 'heap-pressure' :
                        null
                    if (_flushReason){
                        console.log("Indexing block "+(nextBlockHeight)+"("+nextBlockHash+")")
                        await this.db.setLastBlockHeight(nextBlockHeight)
                        await this.db.setLastBlockHash(nextBlockHash)
                        console.log("Inserting data Blocks ("+blocksCount+") Transactions ("+transactionsCount+") Inputs ("+inputsCount+") Outputs("+outputsCount+")")

                        // Atomically record which blocks need K/M cleanup so a crash between
                        // endTransaction and cleanupAgedBlocks is recoverable on restart.
                        if (this.pendingKMCleanup.length > 0) {
                            await this.db.addTransaction("put", P_PENDING_CLEANUP_KEY,
                                Buffer.from(JSON.stringify(this.pendingKMCleanup)))
                        }

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
                        console.log(`⏱ TIMING (${_t.blocks} blocks) flush=${_flushReason} total=${_total}ms | decode=${_t.decode}ms | parse=${_t.parse}ms (out=${_t.parseOut}ms [hash=${_pb.hash}ms ins=${_pb.ins}ms sb=${_pb.sb}ms] in=${_t.parseIn}ms [hintRead=${_pi.hintRead}ms outRead=${_pi.outRead}ms stage=${_pi.stage}ms]) | commit=${_t.commit}ms | cleanup=${_t.cleanup}ms | knownScripts=${_ks.size} hit=${_ksH} miss=${_ksM} rate=${_ksRate}% | heap=${_heapMB}MB heapPre=${_earlyFlushHeapMB.toFixed(0)}MB rss=${_rssMB}MB outCache=${_ocSize}`)
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
                if (this.mempoolInterval) {
                    clearInterval(this.mempoolInterval)
                    this.mempoolInterval = null
                }
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
                console.error('Error updating mempool: ' + error.message, error)
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
            
            
            try {
                await this.mempoolDb.beginTransaction()
                //This deletes the txs that are in the database but not longer in the mempool. Also, it removes
                //the transactions that already exist in the database, leaving rawMempool only with the new transactions from the mempool
                let deletedInfo = await this.mempoolDb.deleteAndCompareTxsNotInList(rawMempool)

                let deletedTransactionsCount = deletedInfo.transactionsDeleted
                let deletedInputsCount = deletedInfo.inputsDeleted
                let deletedOutputsCount = deletedInfo.outputsDeleted

                // Multi-batch passes are throttled by an inter-batch sleep; on a
                // large mempool the cumulative sleep dominates the wall-clock cost
                // of reconverging the in-memory mempool snapshot. Surface an estimate
                // up front so operators can correlate stale pending-balance windows
                // with mempool depth during fee spikes.
                if (rawMempool.length > MEMPOOL_BATCH_SIZE){
                    let batchCount = Math.ceil(rawMempool.length / MEMPOOL_BATCH_SIZE)
                    let estimatedSeconds = ((batchCount - 1) * MEMPOOL_INTER_BATCH_SLEEP) / 1000
                    console.log("Mempool update: "+batchCount+" batches required, estimated minimum reconvergence "+estimatedSeconds+"s")
                }

                let i = 0
                let consecutiveTxFetchFailures = 0
                while(i<rawMempool.length){
                    let nextRawMempoolChunk = rawMempool.slice(i, i+MEMPOOL_BATCH_SIZE)

                    let nextTxsHex = []
                    try {
                        nextTxsHex = await this.connector.getRawTransactions(nextRawMempoolChunk)
                        // Successful fetch — clear the failure streak so a future
                        // transient blip starts counting from zero again.
                        consecutiveTxFetchFailures = 0

                    } catch (err){
                        console.log(err)
                        consecutiveTxFetchFailures = consecutiveTxFetchFailures + 1
                        // If the node stays down, retrying forever here would keep
                        // execution inside the outer try and never reach the finally
                        // that resets mempoolBusy — locking out all future mempool
                        // updates and block sync until a process restart. Bail out
                        // after a bounded number of consecutive failures so the
                        // finally fires and the next interval tick can recover.
                        if (consecutiveTxFetchFailures >= MEMPOOL_MAX_TX_FETCH_RETRIES){
                            console.warn("Giving up on this mempool pass after "+consecutiveTxFetchFailures+" consecutive getRawTransactions failures; will retry on the next interval.", err)
                            break
                        }
                        console.log("There was an error trying to get raw transactions from the mempool. Trying again...", err)
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
                    // mainnet conditions) shouldn't pay a tail latency.
                    if (i < rawMempool.length) {
                        await this.sleep(MEMPOOL_INTER_BATCH_SLEEP)
                    }
                }

                await this.mempoolDb.endTransaction()
                let mempoolEndTime = Date.now()
                let timeString = this.millisecondsToTimeString(mempoolEndTime-mempoolStartTime)

                console.log("Mempool updated!"
                    +" Transactions ("+transactionsCount+" more, "+deletedTransactionsCount+" less)"
                    +" Inputs ("+inputsCount+" more, "+deletedInputsCount+" less) "
                    +" Outputs("+outputsCount+" more, "+deletedOutputsCount+" less) ["+timeString+"]")
            } catch (error){
                // Any failure in the parse/commit path — txFromHex on malformed
                // hex, a parseTransaction error, or a DB I/O fault — must not
                // leave mempoolBusy stuck true; otherwise every subsequent
                // setInterval tick bails with "Mempool is still busy" and the
                // mempool silently stagnates for the lifetime of the process.
                console.error('Error during mempool update: ' + error.message, error)
                try { await this.mempoolDb.endTransaction(false) } catch (_) {}
            } finally {
                this.mempoolBusy = false
            }
        } else {
            console.log("Mempool is still busy")
        }
    }
    
}

module.exports = XChainUtxoTracker
module.exports.satoshiToDecimalString = satoshiToDecimalString
module.exports.SYNCED_THRESHOLD = SYNCED_THRESHOLD