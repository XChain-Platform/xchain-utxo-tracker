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

// Store-commit lock: a block flush changes the confirmed store and the mempool
// store in two steps (commit the confirmed batch, then delete the mined txs'
// mempool records). An address read lists the confirmed store, then the mempool
// store, then probes the mempool per output. A commit landing mid-read shows it a
// mix: a just-mined output in neither store (its spent outpoint served unspent),
// or a mempool refresh's spends without its outputs or vice versa. So every
// address read is a shared reader, and the flush's commit-plus-cleanup, each
// mempool refresh commit (mempool_refresh.js), each reorg rollback commit
// (reorg_verification.js) and the tip-pointer repair commit
// (last_blocks_window.js) are the exclusive writer, since a page reports the
// committed height it read its rows at:
// the writer waits for in-flight reads to drain, and new reads wait while a
// writer is pending or active (writer preference, so a steady read load cannot
// starve the flush). Readers hold nothing the writer needs and vice versa, so
// there is no lock cycle. The state lives on the tracker under a symbol so it
// stays off the serialized and enumerable surface.
const STORE_LOCK = Symbol('storeCommitLock')

function storeLock(tracker){
    if (!tracker[STORE_LOCK]) {
        Object.defineProperty(tracker, STORE_LOCK, {
            value: { readers: 0, writing: false, waiters: [] },
            enumerable: false,
            writable: false,
            configurable: true,
        })
    }
    return tracker[STORE_LOCK]
}

function waitForLockChange(lock){
    return new Promise(resolve => lock.waiters.push(resolve))
}

function wakeLockWaiters(lock){
    const waiters = lock.waiters
    lock.waiters = []
    for (const resolve of waiters) resolve()
}

// Runs one address read as a shared reader of both stores.
async function withStoreRead(tracker, read){
    const lock = storeLock(tracker)
    while (lock.writing) await waitForLockChange(lock)
    lock.readers++
    try {
        return await read()
    } finally {
        lock.readers--
        if (lock.readers === 0) wakeLockWaiters(lock)
    }
}

// Runs one store commit as the exclusive writer; not re-entrant, so never nest it.
async function withStoreCommit(tracker, commit){
    const lock = storeLock(tracker)
    while (lock.writing) await waitForLockChange(lock)
    lock.writing = true
    try {
        while (lock.readers > 0) await waitForLockChange(lock)
        return await commit()
    } finally {
        lock.writing = false
        wakeLockWaiters(lock)
    }
}

// Address reads take the reader side; every commit that changes what they read takes the writer side.
module.exports = { withStoreRead, withStoreCommit }
