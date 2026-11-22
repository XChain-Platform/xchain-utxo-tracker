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
 ********************************************************************/

'use strict'

function evaluateRestoreAgainstNodeTip({ archiveHeight, chainInfo }) {
    if (!Number.isInteger(archiveHeight) || archiveHeight < 0) {
        return { verdict: 'unknown', archiveHeight: null, nodeHeight: null, gap: null, ibd: null,
            detail: 'the archive carries no usable committed height' }
    }
    if (!chainInfo || !Number.isFinite(chainInfo.blocks) || chainInfo.blocks < 0) {
        return { verdict: 'unknown', archiveHeight, nodeHeight: null, gap: null, ibd: null,
            detail: `the coin node tip could not be compared with archive height ${archiveHeight}` }
    }
    const nodeHeight = chainInfo.blocks
    const ibd = chainInfo.initialblockdownload === true
    if (nodeHeight >= archiveHeight) {
        return { verdict: 'ok', archiveHeight, nodeHeight, gap: 0, ibd,
            detail: `the coin node is at ${nodeHeight}, at or above archive height ${archiveHeight}` }
    }
    const gap = archiveHeight - nodeHeight
    if (ibd) {
        return { verdict: 'behind-wait', archiveHeight, nodeHeight, gap, ibd,
            detail: `the coin node is ${gap} blocks below archive height ${archiveHeight} in initial block download` }
    }
    return { verdict: 'behind-refuse', archiveHeight, nodeHeight, gap, ibd,
        detail: `the coin node is at ${nodeHeight}, ${gap} blocks below archive height ${archiveHeight}, and is not in initial block download` }
}

module.exports = { evaluateRestoreAgainstNodeTip }
