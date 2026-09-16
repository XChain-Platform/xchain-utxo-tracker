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
 * XChain UTXO Tracker - UTXO Tracker Class
 *
 ********************************************************************/

const { createHash } = require('crypto')
const bitcoin = require('bitcoinjs-lib')
const util = require('../common/util')
const { satoshiToDecimalString } = require('./catch_up_helpers.js')
const { MAX_ADDRESS_OUTPUTS } = require('./constants.js')

module.exports = {
    async getBalanceInfo(address){
        let script = bitcoin.address.toOutputScript(address, this.network)
        let scriptHash = createHash('sha256').update(script).digest('hex')

        let confirmedBalance = 0n
        let pendingBalance = 0n
        let utxosConfirmed = 0
        let utxosPending = 0
        let totalReceived = 0n

        let confirmedOutputs = await this.db.getOutputsScriptPubKey(scriptHash, { maxOutputs: MAX_ADDRESS_OUTPUTS })
        let mempoolOutputs = await this.mempoolDb.getOutputsScriptPubKey(scriptHash, { maxOutputs: MAX_ADDRESS_OUTPUTS })

        // Outpoints already accounted from the confirmed store. A just-mined tx
        // lives in both stores until the deferred mempool cleanup runs, so the
        // mempool loop must skip any outpoint already counted here or the same
        // coin is double-listed (inflating the reported balance).
        const confirmedKeys = new Set()

        for (let nextOutput of confirmedOutputs) {
            // Same fail-loud guard as getUtxosAddress: a 16-char fallback means
            // the O-record predates the fullTxHash field. get_utxos already throws
            // here; get_info must too, or a pre-format DB silently returns balances
            // while every spend path errors, masking the need for a re-index.
            let txid = requireFullTxid(nextOutput)

            confirmedKeys.add(txid + ':' + nextOutput.vout)

            let amount = BigInt(nextOutput.value)

            // Note: with REMOVE_SPENT=true, totalReceived only reflects currently unspent confirmed outputs
            totalReceived += amount

            // getInput keys on the 8-byte (16-hex) txid prefix, matching insertInput.
            let mempoolInput = await this.mempoolDb.getInput(txid.substring(0, 16), nextOutput.vout)
            // Confirmed output being spent in the mempool: counts as confirmed but pending out
            if (mempoolInput != null) pendingBalance -= amount
            confirmedBalance += amount
            utxosConfirmed++
        }

        for (let nextOutput of mempoolOutputs) {
            // See the confirmed-output loop above: a 16-char fallback means the
            // O-record predates the fullTxHash field and can never spend validly.
            let txid = requireFullTxid(nextOutput)

            // Skip an outpoint already counted from the confirmed store (just-mined
            // tx still present in both stores during the cleanup window).
            if (confirmedKeys.has(txid + ':' + nextOutput.vout)) continue

            let mempoolInput = await this.mempoolDb.getInput(txid.substring(0, 16), nextOutput.vout)
            if (mempoolInput == null) {
                pendingBalance += BigInt(nextOutput.value)
                utxosPending++
            }
        }

        return balanceInfoResult.call(this, address, { confirmedBalance, pendingBalance, totalReceived, utxosConfirmed, utxosPending })
    },

    async getUtxosAddress(address, { limit = null, after = null } = {}){
        const { scriptHash, scriptPubKeyHex, paged, pageLimit } = utxoQueryPlan(address, this.network, limit)

        // Paged mode pulls one bounded page of confirmed outputs (resuming from
        // `after`); unbounded mode pulls everything but is capped by the
        // MAX_ADDRESS_OUTPUTS safety ceiling.
        let confirmedOutputs = await this.db.getOutputsScriptPubKey(scriptHash, paged
            ? { limit: pageLimit, after }
            : { maxOutputs: MAX_ADDRESS_OUTPUTS })
        const nextCursor = nextPageCursor(confirmedOutputs, paged, pageLimit)

        // Mempool outputs are unpaginated (the mempool set is small and bounded).
        // In paged mode include them only on the first page (after == null) so they
        // are not duplicated across pages.
        let mempoolOutputs = (!paged || after == null)
            ? await this.mempoolDb.getOutputsScriptPubKey(scriptHash, { maxOutputs: MAX_ADDRESS_OUTPUTS })
            : []

        let results = []
        // Outpoints emitted from the confirmed store, so the mempool loop can skip
        // a just-mined tx that still lives in both stores during the deferred
        // cleanup window (otherwise the same outpoint is returned twice, handing
        // the encoder a duplicate input).
        const confirmedKeys = new Set()

        for (let nextOutput of confirmedOutputs) {
            let txid = claimConfirmedOutpoint(confirmedKeys, nextOutput)

            // Skip confirmed outputs being spent in the mempool. getInput keys on
            // the 8-byte (16-hex) txid prefix, matching insertInput.
            let mempoolInput = await this.mempoolDb.getInput(txid.substring(0, 16), nextOutput.vout)
            if (mempoolInput != null) continue

            addServableConfirmedUtxo.call(this, results, nextOutput, txid, scriptPubKeyHex)
        }

        for (let nextOutput of mempoolOutputs) {
            // See the confirmed-output loop above: a 16-char fallback means the
            // O-record predates the fullTxHash field and can never spend validly.
            let txid = requireFullTxid(nextOutput)
            // Skip an outpoint already emitted from the confirmed store (just-mined
            // tx still present in both stores during the cleanup window). confirmedKeys
            // is a fast path but only holds THIS page's confirmed rows: in paged mode
            // the confirmed twin of a both-stores outpoint can sit on a later page, so
            // the page-scoped set misses it and the same outpoint would be returned
            // twice across pages (handing the encoder a duplicate input). Fall back to
            // a point-probe of the confirmed store's live H record, which is page
            // independent, so the outpoint is emitted only from the confirmed store.
            if (confirmedKeys.has(txid + ':' + nextOutput.vout)) continue
            // Across pages the page's own list cannot see an outpoint emitted on an
            // earlier page, so ask the confirmed store directly.
            if (paged && await this.db.hasOutputForTx(txid.substring(0, 16), nextOutput.vout)) continue
            // Skip mempool outputs that are also spent by another mempool tx
            let mempoolInput = await this.mempoolDb.getInput(txid.substring(0, 16), nextOutput.vout)
            if (mempoolInput != null) continue
            results.push(mempoolUtxo(nextOutput, txid, scriptPubKeyHex))
        }

        return withNextCursor(results, paged, nextCursor)
    },

    async getFirstSeen(address){
        const script = bitcoin.address.toOutputScript(address, this.network)
        const scriptHash = createHash('sha256').update(script).digest('hex')

        const record = await this.db.getOutputScriptBlock(scriptHash)
        // An address this tracker has never seen has no first-seen height to report.
        if (!record) return null

        return { height: record.h }
    }
}

// The fail-loud txid guard: a stored output must carry its full 64-char txid,
// since a 16-char key prefix means the record predates the fullTxHash field.
function requireFullTxid(nextOutput){
    let txid = nextOutput.fullTxid || nextOutput.txid

    // A valid txid is the full 32-byte hash (64 hex chars). When fullTxid
    // is null the fallback yields the 8-byte O-key prefix (16 hex chars),
    // which happens only for O-records written before the full hash was
    // added to the O-record format. Such a record can never produce a
    // valid spend, so fail loudly here rather than letting the truncated
    // id silently corrupt a downstream PSBT. Re-index this LevelDB.
    if (txid.length !== 64) {
        throw new Error(
            `UTXO record is missing a fullTxHash (got ${txid.length}-char key prefix instead of a 64-char txid).` +
            ` This record predates the O-record fullTxHash field; re-index this LevelDB before use.` +
            ` UTXO key: ${nextOutput.txid}`
        )
    }
    return txid
}

// The fail-loud txid guard for one confirmed output, then its outpoint recorded
// so the mempool loop can skip the same coin.
function claimConfirmedOutpoint(confirmedKeys, nextOutput){
    let txid = requireFullTxid(nextOutput)
    confirmedKeys.add(txid + ':' + nextOutput.vout)
    return txid
}

// The address's script keys and the paging plan of one get_utxos call.
function utxoQueryPlan(address, network, limit){
    let script = bitcoin.address.toOutputScript(address, network)
    let scriptHash = createHash('sha256').update(script).digest('hex')
    let scriptPubKeyHex = util.uint8ArrayToHex(script)

    const paged = Number.isFinite(limit) && limit > 0
    const pageLimit = paged ? Math.floor(limit) : null
    return { scriptHash, scriptPubKeyHex, paged, pageLimit }
}

// Continuation cursor for the next page, captured BEFORE the loop below
// rewrites each output's `txid` to the full hash. The cursor is the last
// *scanned* confirmed DB key (txHash8:vout), independent of mempool-spend
// filtering, so the next page resumes with no gaps or repeats. Only set
// when a full page was read (more rows may remain).
function nextPageCursor(confirmedOutputs, paged, pageLimit){
    return (paged && confirmedOutputs.length === pageLimit)
        ? confirmedOutputs[confirmedOutputs.length - 1].txid + ':' + confirmedOutputs[confirmedOutputs.length - 1].vout
        : null
}

// Adds the response entry for one confirmed output the mempool is not
// spending, unless the output is withheld.
function addServableConfirmedUtxo(results, nextOutput, txid, scriptPubKeyHex){
    const confirmations = this.blockchainInfoLastBlock - nextOutput.height + 1

    // Withhold an output whose count came out NEGATIVE. blockchainInfoLastBlock
    // is -1 both in the constructor and again at the top of every startTracking
    // run, so until the first getblockchaininfo lands this subtraction is
    // negative for every stored output. The consumer contract is non-negative:
    // xchain-encoder validator.js validateUtxoEntry and UtxoTracker.js both
    // throw `confirmations must be a non-negative integer`, and that throw
    // aborts the WHOLE address fetch, not just the one entry. Zero is
    // deliberately still served: it is the encoder's unconfirmed marker
    // (`confirmations == 0`) and the pinned stale-tip behaviour in
    // test/boundary/confirmations.test.js, so only the value that would throw
    // is dropped.
    if (confirmations < 0) return

    // Withhold immature coinbase outputs: every node rejects a spend
    // of a coinbase output below coinbaseMaturity confirmations, so serving
    // it as spendable would hand a caller an input that can never confirm.
    // The depth is per coin/network, not a universal 100 (src/chain/coinbase_maturity.js).
    // Legacy O-records carry coinbase=false and are unaffected. Coinbase
    // outputs only exist in the confirmed store, so no equivalent filter is
    // needed on the mempool loop below.
    if (nextOutput.coinbase && this.coinbaseMaturity > 0 && confirmations < this.coinbaseMaturity) return

    nextOutput.txid = txid
    nextOutput.confirmations = confirmations
    // Two money fields, units differing by 10^8, and both are served.
    // `value` is SATOSHIS as an exact decimal string (it can exceed
    // 2^53-1 on DOGE, so parse it as a BigInt): it is the field to spend
    // and to sum, and the only one the encoder validates. `amount` is
    // COIN-denominated, derived from `value` for display, and must never
    // be spent or summed as satoshis. Confusing the two cost xchain-hub a
    // live incident (satoshis summed into a whole-coin floor left the
    // guard inert); its xchain-hub/src/lib/utxo_balance.js helper exists
    // because of it.
    nextOutput.amount = satoshiToDecimalString(nextOutput.value)
    nextOutput.scriptPubKey = scriptPubKeyHex
    results.push(nextOutput)
}

// The response entry for one mempool output nothing else spends.
function mempoolUtxo(nextOutput, txid, scriptPubKeyHex){
    nextOutput.txid = txid
    nextOutput.height = null
    nextOutput.confirmations = 0
    // Same dual-unit contract as the confirmed loop above: `value` is
    // satoshis and is what gets spent, `amount` is the derived
    // coin-denominated display string.
    nextOutput.amount = satoshiToDecimalString(nextOutput.value)
    nextOutput.scriptPubKey = scriptPubKeyHex
    return nextOutput
}

// Expose the continuation cursor as a non-enumerable property so the array
// still serializes as a bare UTXO list (preserving the existing API/JSON-RPC
// contract) while the REST layer can read it for the X-Next-Cursor header.
function withNextCursor(results, paged, nextCursor){
    if (paged) Object.defineProperty(results, 'nextCursor', { value: nextCursor, enumerable: false })

    return results
}

// The get_info response body, balances as coin-denominated decimal strings.
function balanceInfoResult(address, { confirmedBalance, pendingBalance, totalReceived, utxosConfirmed, utxosPending }){
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
