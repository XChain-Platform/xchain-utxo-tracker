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
'use strict'

// One-at-a-time section shared by the reorg rollback of a block and a backfill
// chunk write. The rollback reads a block's V records, stages their deletes and
// commits, with awaits between; a backfill chunk written in that gap would add A
// rows for the block after the unwind had listed them, and they would outlive
// the block. Inside this section the backfill re-checks that each block is still
// committed before it writes, and the rollback lists V after any backfill write.

const HISTORY_WRITE = Symbol('historyWriteLock')

async function withHistoryWrite(tracker, fn){
    const previous = tracker[HISTORY_WRITE] || Promise.resolve()
    let release
    const mine = new Promise((resolve) => { release = resolve })
    tracker[HISTORY_WRITE] = previous.then(() => mine)
    await previous
    try {
        return await fn()
    } finally {
        release()
    }
}

module.exports = { withHistoryWrite }
