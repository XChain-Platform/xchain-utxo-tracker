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

// Address-query pagination
// A single-address output scan (O-prefix range) can return millions of rows for a
// mega miner-coinbase/payout address. Materializing them all into one array OOMs
// the process and takes the tracker down for every caller. getOutputsScriptPubKey
// therefore supports a bounded page (`limit` + `after` cursor) and a fail-loud
// safety ceiling (`maxOutputs`) for unbounded callers.

// Thrown when an unbounded scan would exceed the safety ceiling. The API layer
// maps `.code` to HTTP 413 so callers switch to ?limit=&after= pagination.
class AddressTooLargeError extends Error {
    constructor(maxOutputs) {
        super(`address has more than ${maxOutputs} outputs; page the result with ?limit=&after=`)
        this.name = 'AddressTooLargeError'
        this.code = 'ADDRESS_TOO_LARGE'
        this.maxOutputs = maxOutputs
        // JSON-RPC router serializes Error instances by enumerable props only;
        // .code is a non-enumerable own property so it arrives as null at the
        // client. Mirror it into .data so the router preserves it.
        this.data = { code: this.code }
    }
}

// Thrown when a pagination cursor is malformed (the API layer maps to HTTP 400).
class InvalidCursorError extends Error {
    constructor(cursor) {
        super(`invalid pagination cursor ${JSON.stringify(cursor)} (expected "<txHash8Hex>:<vout>")`)
        this.name = 'InvalidCursorError'
        this.code = 'INVALID_CURSOR'
        // Mirror .code into .data for the same reason as AddressTooLargeError above.
        this.data = { code: this.code }
    }
}

module.exports = { AddressTooLargeError, InvalidCursorError }
