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
 * XChain UTXO Tracker - address to output script decoding
 *
 ********************************************************************/

const bitcoin = require('bitcoinjs-lib')

// Litecoin Core on test networks hands out P2SH addresses with SCRIPT_ADDRESS2
// (0x3a, 'Q...') by default, alongside the legacy 0xc4 form. Both encode the
// same hash160 and spend the same P2SH script, but the network definition
// carries only 0xc4, so bitcoinjs-lib rejects the 0x3a form. Mainnet is left
// strict: its definition and the 0x3a version byte are not tied together here.
const LTC_TEST_BECH32 = new Set(['tltc', 'rltc'])
const LTC_P2SH_V2_VERSION = 0x3a

// A bad, oversized (bech32 tops out at 90) or wrong-network address is a caller
// mistake: a BAD_REQUEST error answered 400 / -32602 with no error log. Only
// input within the bound is decoded, so the message echoes at most 128 chars.
function addressToScript(address, network){
    let reason = 'invalid address for this network'
    try {
        if (typeof address === 'string' && address.length > 0 && address.length <= 128) return decodeAddressScript(address, network)
    } catch (err) { reason = String((err && err.message) || reason).slice(0, 256) }
    throw Object.assign(new Error(reason), { code: 'BAD_REQUEST' })
}

// Pay-to-anchor (P2A): witness v1, 2-byte program 4e73, script 51024e73. Core
// names it with a bech32m address but bitcoinjs-lib maps v1 only at 32 bytes.
// Only that exact program on the network prefix is accepted (checksum verified).
function decodePayToAnchor(address, network){
    if (!network || typeof network.bech32 !== "string") return null
    let d
    try { d = bitcoin.address.fromBech32(address) } catch (_) { return null }
    if (d.prefix !== network.bech32 || d.version !== 1 || d.data.toString("hex") !== "4e73") return null
    return Buffer.from("51024e73", "hex")
}

function decodeAddressScript(address, network){
    try {
        return bitcoin.address.toOutputScript(address, network)
    } catch (err) {
        const anchor = decodePayToAnchor(address, network)
        if (anchor) return anchor
        if (!network || !LTC_TEST_BECH32.has(network.bech32)) throw err
        let decoded
        try { decoded = bitcoin.address.fromBase58Check(address) } catch (_) { throw err }
        if (decoded.version !== LTC_P2SH_V2_VERSION || decoded.hash.length !== 20) throw err
        return bitcoin.address.toOutputScript(bitcoin.address.toBase58Check(decoded.hash, network.scriptHash), network)
    }
}

// The 0x3a P2SH form on an LTC test network rewritten to its 0xc4 twin; any other
// address is returned unchanged. Lets type classification share decodeAddressScript's rule.
function canonicalP2shAddress(address, network){
    if (typeof address !== 'string' || !network || !LTC_TEST_BECH32.has(network.bech32)) return address
    try {
        const decoded = bitcoin.address.fromBase58Check(address)
        if (decoded.version !== LTC_P2SH_V2_VERSION || decoded.hash.length !== 20) return address
        return bitcoin.address.toBase58Check(decoded.hash, network.scriptHash)
    } catch (_) { return address }
}

module.exports = { addressToScript, canonicalP2shAddress }
