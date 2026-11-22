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
 * XChain UTXO Tracker - AuxPoW Block Fetch Fallback
 *
 ********************************************************************/
'use strict'

const crypto = require('crypto')

function assertHeaderMatchesHash(height, hash, hex) {
    const header = Buffer.from(hex.slice(0, 160), 'hex')
    const once = crypto.createHash('sha256').update(header).digest()
    const actual = Buffer.from(crypto.createHash('sha256').update(once).digest()).reverse().toString('hex')
    if (header.length !== 80 || actual !== String(hash).toLowerCase()) {
        throw new Error(`reassembled block ${height} header hashes to ${actual}, expected ${hash}`)
    }
}

async function fetchAuxPowBlock(connector, height, log) {
    const hash = await connector.getBlockHash(height)
    try {
        return { height, hash, hex: await connector.getBlockWithoutAuxPow(hash) }
    } catch (err) {
        if (!err || !err.auxPowParseFailure) throw err
        log(`AuxPoW strip failed at height ${height} (${hash}); reassembling from RPC parts`)
        const hex = await connector.getBlockReassembled(hash)
        assertHeaderMatchesHash(height, hash, hex)
        return { height, hash, hex }
    }
}

// A committed block's bytes fail AuxPoW stripping deterministically, so a
// tagged batch failure refetches per block immediately rather than retrying.
async function fetchBlocksWithAuxPowFallback(connector, heights, auxPow, log = () => {}) {
    if (!auxPow) return connector.getBlocksBatch(heights)
    try {
        return await connector.getBlocksBatchWithoutAuxPow(heights)
    } catch (err) {
        if (!err || !err.auxPowParseFailure) throw err
        log(`AuxPoW strip failed in batch ${heights[0]}..${heights[heights.length - 1]}; refetching per block`)
        const blocks = []
        for (const height of heights) blocks.push(await fetchAuxPowBlock(connector, height, log))
        return blocks
    }
}

module.exports = { assertHeaderMatchesHash, fetchAuxPowBlock, fetchBlocksWithAuxPowFallback }
