'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// An aged block's prune lists its V rows, then commits its N delete. A backfill
// chunk reads that same N record to decide whether to write V rows, so a chunk
// that lands between the listing and the commit would leave V rows with no block.
// Both sides run here as they do in the tracker, over a store model that applies
// staged deletes only at commit.

const { expect } = require('chai');
const lastBlocksWindow = require('../../../src/XChainUtxoTracker/last_blocks_window');
const HistoryBackfill = require('../../../src/native_history/backfill');

const BLOCK = 'ab'.repeat(32);
const SCRIPT_HEX = '76a914' + '11'.repeat(20) + '88ac';

function deferred() {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
}

function makeStore() {
    const store = { n: new Set([BLOCK]), v: new Set(), staged: [], listed: deferred(), release: deferred() };
    const noop = async () => {};
    store.db = {
        beginTransaction: async () => { store.staged = []; },
        addTransaction: noop,
        endTransaction: async () => { for (const op of store.staged) op(); store.staged = []; },
        processDeletedOutputs: noop,
        removeCreatedOutputsBlockIndexOnly: noop,
        removeOutputScriptsBlockIndexOnly: noop,
        removeTxBlockRecoveryIndexOnly: noop,
        removeLastStoredBlock: async (hash) => { store.staged.push(() => store.n.delete(hash)); },
        removeHistoryBlockIndexOnly: async () => {
            for (const key of [...store.v]) store.staged.push(() => store.v.delete(key));
            store.listed.resolve();
            await store.release.promise;
        },
        getBackfillBlockChecks: async (hashes) => hashes.map((h) => ({ height: 5, inWindow: store.n.has(h) })),
        writeHistoryBackfill: async (rows) => {
            for (const r of rows) if (r.indexed) store.v.add(r.blockHash + ':' + r.txid);
        },
    };
    return store;
}

function chunkFor(runner) {
    const buf = Buffer.from(SCRIPT_HEX, 'hex');
    runner.watch.set(SCRIPT_HEX, { epoch: 1, progress: { next: 0 } });
    const work = [{ hex: SCRIPT_HEX, buf, epoch: 1, next: 6, open: new Map() }];
    const rows = [{ state: { buf, open: new Map() }, height: 5, txid: 'cd'.repeat(32), received: 1n, sent: 0n, time: 1, hash: BLOCK }];
    return { scanned: [{ hash: BLOCK, height: 5 }], rows, work };
}

describe('aged-block prune against a concurrent history backfill chunk', function () {
    it('leaves no V rows behind for a block whose N record the prune deleted', async function () {
        const store = makeStore();
        const tracker = { db: store.db, pendingKMCleanup: [BLOCK], lastBlocks: [] };
        const runner = new HistoryBackfill(tracker, new Map(), { openMax: 100 });
        const { scanned, rows, work } = chunkFor(runner);

        const prune = lastBlocksWindow.cleanupAgedBlocks.call(tracker);
        await store.listed.promise;
        const chunk = runner.commitChunk(scanned, rows, work);
        await new Promise((resolve) => setTimeout(resolve, 25));
        store.release.resolve();
        await Promise.all([prune, chunk]);

        expect(store.n.has(BLOCK)).to.equal(false);
        expect([...store.v]).to.deep.equal([]);
        expect(await chunk).to.equal(true);
    });

    it('lists a V row written by a chunk that landed before the prune started', async function () {
        const store = makeStore();
        const tracker = { db: store.db, pendingKMCleanup: [BLOCK], lastBlocks: [] };
        const runner = new HistoryBackfill(tracker, new Map(), { openMax: 100 });
        const { scanned, rows, work } = chunkFor(runner);

        expect(await runner.commitChunk(scanned, rows, work)).to.equal(true);
        expect(store.v.size).to.equal(1);
        store.release.resolve();
        await lastBlocksWindow.cleanupAgedBlocks.call(tracker);

        expect(store.n.has(BLOCK)).to.equal(false);
        expect([...store.v]).to.deep.equal([]);
    });
});
