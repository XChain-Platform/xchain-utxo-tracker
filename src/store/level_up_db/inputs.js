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
 **********************************************************************/

const { EMPTY, P_INPUT, P_IN_HINT } = require('./constants')
const { kInput, kOutHint, kInHint, h2b, pb, rangeEnd } = require('./key_codec')
const { encodeInputVal } = require('./value_codec')

module.exports = {
    // Input (I prefix)

    async insertInput(input) {
        return await this.addTransaction(
            "put",
            kInput(input.prevTxHash, input.prevOutputIndex),
            encodeInputVal(input.txHash)
        )
    },

    async getInput(txid, outputIndex){
        const value = await this.db.get(kInput(txid, outputIndex))
        return value === undefined ? null : value
    },

    // True iff a LIVE output for (txid, outputIndex) exists in this store. The
    // H (output hint) record is written for every confirmed output and deleted
    // when it is spent, so its presence is a committed-state membership probe for
    // a single outpoint, independent of any page boundary. Used by the paged
    // getUtxosAddress path to dedupe a just-mined outpoint that still lives in both
    // the confirmed and mempool stores, without materializing the full confirmed set.
    async hasOutputForTx(txid, outputIndex){
        const value = await this.db.get(kOutHint(txid, outputIndex))
        return value !== undefined
    },

    // Input hint (J prefix)

    async insertInputHint(input) {
        return await this.addTransaction(
            "put",
            kInHint(input.txHash, input.prevTxHash, input.prevOutputIndex),
            EMPTY
        )
    },

    async deleteInputsByHint(txid){
        const prefix = Buffer.concat([pb(P_IN_HINT), h2b(txid)])

        const options = {
            gte: prefix,
            lte: rangeEnd(prefix),
            keys: true,
            values: true
        }

        let inputsCount = 0

        for await (const [key] of this.db.iterator(options)) {
            // J key layout: [J(1)][txid(32)][prevTxid(32)][outputIndex(4)]
            const prevTxidBuf = key.slice(33, 65)
            const idxBytes    = key.slice(65, 69)

            await this.addTransaction(
                "del",
                Buffer.concat([pb(P_INPUT), prevTxidBuf, idxBytes]),
                null
            )
            await this.addTransaction("del", key, null)
            inputsCount++
        }

        return inputsCount
    },

    async deleteInputsByHints(txids){
        const counts = await Promise.all(txids.map(txid => this.deleteInputsByHint(txid)))
        return counts.reduce((sum, n) => sum + n, 0)
    },
}
