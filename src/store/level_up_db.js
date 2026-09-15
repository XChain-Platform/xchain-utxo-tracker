/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************
 *
 * XChain UTXO Tracker - LevelUpStore Class
 *
 * This file handles reading and writing UTXO tracker data to LevelDB database
 *
 * Key/value encoding: all hashes stored as raw binary Buffers (not hex strings)
 * to minimize database size.
 *
 * Key layouts (byte sizes):
 *   B: [0x42][blockHash(32)]                                          = 33 B
 *   T: [0x54][txHash8(8)]                                             =  9 B
 *   I: [0x49][prevTxHash8(8)][outputIndex(4)]                        = 13 B
 *   O: [0x4F][scriptPubKey(32)][txHash8(8)][outputIndex(4)]          = 45 B
 *   H: [0x48][txHash8(8)][outputIndex(4)]                            = 13 B
 *   J: [0x4A][txHash8(8)][prevTxHash8(8)][outputIndex(4)]            = 21 B
 *   S: [0x53][scriptPubKey(32)]                                       = 33 B
 *   Z: [0x5A][blockHash(32)][scriptPubKey(32)]                        = 65 B
 *   K: [0x4B][blockHash(32)][scriptPubKey(32)][txHash8(8)][idx(4)]   = 77 B
 *   M: [0x4D][blockHash(32)][txHash8(8)][outputIndex(4)]             = 45 B
 *   N: [0x4E][blockHash(32)]                                          = 33 B
 *   W: [0x57][blockHash(32)][txHash8(8)][outputIndex(4)]             = 45 B
 *   R: [0x52]                                                         =  1 B
 *
 * Single-byte diagnostic records (no suffix; at most one of each per store):
 *   P: [0x50] pending K/M cleanup list, Q: [0x51] undo-window watermark
 *      (both owned by XChainUtxoTracker.js), R: [0x52] the halt marker below.
 *
 * Value layouts:
 *   B: [height(4)][timestamp(4)][previousHash(32)]                   = 40 B
 *   T: [blockHash(32)]                                                = 32 B
 *   I: [txHash8(8)]                                                   =  8 B
 *   O: [value(8)][height(4)][fullTxHash(32)]{[coinbase(1)]}          = 44/45 B
 *   H: [scriptPubKey(32)]                                             = 32 B
 *   S: [height(4)]                                                    =  4 B
 *   W: [scriptPubKey(32)]                                             = 32 B
 *   R: UTF-8 JSON {"reason","height","at"}                            = variable
 *
 ********************************************************************/

// Load required libraries
const util = require('../common/util')
const loadPart = require
const { AddressTooLargeError, InvalidCursorError } = require('./level_up_db/store_errors')
const { encodeOutput, decodeOutput, encodeBlock, encodeTx, encodeInputVal, encodeOutHint } = require('./level_up_db/value_codec')
const { kOutBlk, kOutputFromBuf, kOutDelFromBuf, kScriptBlkFromBuf, kBlkScriptFromBuf, kBlock, kTx, kScriptBlk, kBlkScript, kInput, kOutput, kOutHint, kInHint, kOutDel, kHintDel, kStoredBlk, rangeEnd } = require('./level_up_db/key_codec')


// Whole key of the halt marker: the one record that says this store was declared
// unrecoverable (rolled back past its undo window) and why. 0x52 ('R') is unused
// by every k* builder above and by the P/Q diagnostics XChainUtxoTracker.js owns.
const HALT_MARKER_KEY = Buffer.from([0x52])


class LevelUpStore {
    static parseInBuckets = { hintRead: 0, outRead: 0, stage: 0 }
    static outputCache = new Map()
    static outputCacheHits = 0
    static outputCacheMisses = 0
    static knownScripts = new Set()
    static knownScriptsHits = 0
    static knownScriptsMisses = 0

    constructor(dbName, inMemory = false) {
        this.dbName = dbName
        this.db = null
        // A live staging Map from construction: the established contract is that a
        // caller may write (addTransaction/setX) before an explicit beginTransaction
        // and flush it with a single endTransaction(true). verifyReorg's boot-time
        // pointer-repair branch instead needs its writes committed durably before it
        // re-reads the on-disk pointer, so that branch opens its OWN begin/endTransaction
        // rather than relying on this Map (which it would otherwise stage into and spin).
        this.transactionArray = new Map()
        this.deletedTransactionArray = new Map()
        this.inMemory = inMemory
    }


    // Drop every process-global cache that DESCRIBES the on-disk store. Both are pure
    // read accelerators rebuilt from disk on the next miss, so a reset can only cost a
    // re-warm, never a wrong answer. Called from createDatabase so no cache can outlive
    // the database it describes: restorebootstrap wipes /data, extracts an OLDER
    // snapshot and re-runs XChainUtxoTracker.start() in the SAME process, and a
    // knownScripts entry for a script first seen AFTER that snapshot makes replay
    // Tier-0 hit and skip rewriting its S/Z records, losing that script's first-seen
    // height permanently (api.js restorebootstrap -> launchTracker -> start).
    static resetCaches(){
        LevelUpStore.outputCache = new Map()
        LevelUpStore.outputCacheHits = 0
        LevelUpStore.outputCacheMisses = 0
        LevelUpStore.knownScripts = new Set()
        LevelUpStore.knownScriptsHits = 0
        LevelUpStore.knownScriptsMisses = 0
    }


    // Halt marker (R key)
    //
    // Written the moment the tracker halts for a resync and read back before the
    // sync loop starts, so a restart knows the store is the one already declared
    // unrecoverable instead of rediscovering it by rolling back into a drained
    // window. Direct puts and dels, never staged: the halt fires after the open
    // batch was discarded, and a marker that waits for a batch no restart will
    // commit is the same as no marker.

    // Returns {reason, height, at} or null when the store carries no marker. A
    // marker that cannot be parsed reads as null too: a corrupt diagnostic must
    // not stop the tracker from booting, and the sync loop re-detects the fault.
    async getHaltMarker(){
        const raw = await this.db.get(HALT_MARKER_KEY)
        if (raw === undefined) return null
        try {
            const parsed = JSON.parse(raw.toString())
            if (!parsed || typeof parsed !== 'object' || typeof parsed.reason !== 'string') return null
            return {
                reason: parsed.reason,
                height: Number.isInteger(parsed.height) ? parsed.height : null,
                at:     typeof parsed.at === 'string' ? parsed.at : null
            }
        } catch (_) {
            return null
        }
    }

    async setHaltMarker({ reason, height = null, at = null }){
        const record = {
            reason: String(reason),
            height: Number.isInteger(height) ? height : null,
            at:     at || new Date().toISOString()
        }
        await this.db.put(HALT_MARKER_KEY, Buffer.from(JSON.stringify(record)))
        return record
    }

    async deleteHaltMarker(){
        await this.db.del(HALT_MARKER_KEY)
        return true
    }


}

module.exports = LevelUpStore

Object.assign(LevelUpStore.prototype,
    loadPart('./level_up_db/store_lifecycle.js'),
    loadPart('./level_up_db/blocks_and_transactions.js'),
    loadPart('./level_up_db/inputs.js'),
    loadPart('./level_up_db/outputs.js'),
    loadPart('./level_up_db/output_cleanup.js'),
    loadPart('./level_up_db/output_scripts.js'),
)

// Attached to the class rather than exported one line at a time: one export
// shape per file, and every call site already reaches these through the module
// object, so nothing outside changes.
Object.assign(module.exports, {
    AddressTooLargeError,
    InvalidCursorError,
    // Exported so the bulk-sync loader can write O-record values byte-identically
    // to the live path (optional 45th coinbase byte), reusing this single
    // source of the encoding instead of duplicating the format.
    encodeOutput,
    decodeOutput,
    // Exported so the value encoders' width guards can be exercised directly in unit
    // tests, mirroring the key builders' length-guard coverage.
    encodeBlock,
    encodeTx,
    encodeInputVal,
    encodeOutHint,
    // Exported so the bulk-sync loader can assert its seeded W (creation-block
    // reverse index) keys are byte-identical to the live insertOutputBlock path,
    // reusing this single source of the key encoding instead of duplicating it.
    kOutBlk,
    // Exported so the Buffer-based key builders' length guards can be exercised
    // directly in unit tests, mirroring their hex-string counterparts.
    kOutputFromBuf,
    kOutDelFromBuf,
    kScriptBlkFromBuf,
    kBlkScriptFromBuf,
    // Exported so the hex-string key builders' length guards can be exercised
    // directly in unit tests, mirroring their *FromBuf counterparts.
    kBlock,
    kTx,
    kScriptBlk,
    kBlkScript,
    // Exported so the key-schema invariant test can assert, in ONE place, that
    // every key any builder emits sorts at or below rangeEnd(prefix) (the
    // dropped-key hazard fixed twice: 1-byte then 12-byte 0xFF suffixes), that
    // prefix bytes stay unique, and that hex/Buffer builder pairs stay
    // byte-identical. A new or widened key type must pass that suite.
    kInput,
    kOutput,
    kOutHint,
    kInHint,
    kOutDel,
    kHintDel,
    kStoredBlk,
    rangeEnd,
    // Exported so the halt-marker tests can assert the record sits under the one
    // reserved byte and collides with no k* builder.
    HALT_MARKER_KEY,
})
