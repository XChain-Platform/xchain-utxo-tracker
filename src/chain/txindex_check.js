/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 *********************************************************************/

'use strict'

const MISSING_TXINDEX_WARNING = 'WARNING: node does not appear to have txindex=1 (getrawtransaction on a ' +
    'confirmed tx returned nothing). The malformed-AuxPoW block recovery path ' +
    '(getBlockReassembled) requires txindex; without it a malformed-AuxPoW ' +
    'block will wedge this tracker permanently. Restart the node with txindex=1.'

// Warn at boot when the node lacks txindex=1, the precondition of the malformed-AuxPoW
// recovery path, matching the decoder's boot probe. Advisory only: never throws and never
// exits. Skips a connector without probeTxIndex (tests stub connectors with plain objects).
// Returns the probe result: true, false, or null for inconclusive or skipped.
async function warnIfTxIndexMissing(connector, log) {
    if (!connector || typeof connector.probeTxIndex !== 'function') return null
    let ok = null
    try { ok = await connector.probeTxIndex() } catch (_) { ok = null }
    if (ok === false) log.error(MISSING_TXINDEX_WARNING)
    else if (ok === null) log.info('txindex probe inconclusive (empty chain or probe RPC failed); continuing.')
    return ok
}

module.exports = { warnIfTxIndexMissing, MISSING_TXINDEX_WARNING }
