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

// The backfill job through the real sync loop: a first request for addresses the
// tracker was not watching rebuilds their past from the node's blocks, byte for
// byte what live ingest writes for the same blocks, and a reorg below the point
// where live ingest took over unwinds the rebuilt rows like live ones.

const { expect } = require('chai');
const { buildChain, makeNode, useSyncLoopHarness } = require('../sync_loop/support/harness');
const HistoryBackfill = require('../../../src/native_history/backfill');
const { coinbaseAddress, spendTxid, scriptOf, historyRowsOf, watchFromGenesis, until } = require('./support/chain_history');

// Every requested address's A rows, keyed by address.
async function rowsByAddress(db, addresses) {
    const out = {};
    for (const a of addresses) out[a] = await historyRowsOf(db, a);
    return out;
}

function allComplete(tracker, addresses) {
    return () => tracker.getNativeHistory(addresses, { limit: 100 }, { ip: 'test' })
        .then((read) => addresses.every((a) => read.addressStatus[a].history_status === 'complete'));
}

describe('native history backfill: rebuilding a newly watched address\'s past', function () {
    const h = useSyncLoopHarness();
    this.timeout(30000);

    it('writes the same rows live ingest writes for the same blocks, in one pass for the batch', async function () {
        const chain = buildChain(13);
        // Paid at 1 and spent at 3; paid at 4; paid at 9 and spent at 11.
        const addresses = [coinbaseAddress(1, 0), coinbaseAddress(4, 0), coinbaseAddress(9, 0)];
        watchFromGenesis(h, addresses);
        const live = await h.run(makeNode(chain), (n) => (n >= 2 ? 'stop' : null), {
            inspect: async (s) => { s.rows = await rowsByAddress(h.tracker.db, addresses); }
        });
        h.seedMainStore(async () => {});
        const rebuilt = await h.run(makeNode(chain), async (n, s) => {
            if (n === 1) {
                s.first = await h.tracker.getNativeHistory(addresses, { limit: 100 }, { ip: 'test' });
                return null;
            }
            await until(allComplete(h.tracker, addresses));
            return 'stop';
        }, { inspect: async (s) => { s.rows = await rowsByAddress(h.tracker.db, addresses); } });
        expect(rebuilt.first.addressStatus[addresses[0]].history_status).to.equal('backfilling');
        expect(h.tracker.historyBackfill.passesStarted).to.equal(1);
        expect(live.rows[addresses[0]]).to.have.length(2);
        expect(rebuilt.rows).to.deep.equal(live.rows);
    });

    it('lets a reorg unwind rebuilt rows and records the replacement blocks live', async function () {
        const node = makeNode(buildChain(13));
        const orphaned = coinbaseAddress(11, 0);
        const spentAtFork = coinbaseAddress(9, 0);
        const seen = await h.run(node, async (n, s) => {
            if (n === 1) {
                await h.tracker.getNativeHistory([orphaned, spentAtFork], { limit: 100 }, { ip: 'test' });
                return null;
            }
            if (n === 2) {
                await until(allComplete(h.tracker, [orphaned, spentAtFork]));
                s.before = (await h.tracker.getNativeHistory([orphaned], { limit: 100 }, { ip: 'test' })).transactions.length;
                node.retired = node.chain;
                node.chain = buildChain(16, 7, node.chain, 10);
                return null;
            }
            return n >= 4 ? 'stop' : null;
        }, {
            inspect: async (s) => {
                s.orphan = await h.tracker.getNativeHistory([orphaned], { limit: 100 }, { ip: 'test' });
                s.spent = await h.tracker.getNativeHistory([spentAtFork], { limit: 100 }, { ip: 'test' });
            }
        });
        expect(seen.before).to.equal(1);
        expect(h.tracker.reorgCount).to.equal(1);
        expect(seen.orphan.transactions).to.deep.equal([]);
        expect(seen.spent.transactions.map((t) => [t.height, t.txid])).to.deep.equal([
            [11, spendTxid(node.chain[11])], [9, node.chain[9].coinbase],
        ]);
    });
});

describe('native history backfill: resuming', function () {
    const h = useSyncLoopHarness();
    this.timeout(30000);

    it('picks an address up from its last committed chunk after the runner is stopped and reloaded', async function () {
        const chain = buildChain(13);
        const addresses = [coinbaseAddress(1, 0), coinbaseAddress(9, 0)];
        watchFromGenesis(h, addresses);
        const live = await h.run(makeNode(chain), (n) => (n >= 2 ? 'stop' : null), {
            inspect: async (s) => { s.rows = await rowsByAddress(h.tracker.db, addresses); }
        });
        h.seedMainStore(async () => {});
        const first = scriptOf(addresses[0]).toString('hex');
        const rebuilt = await h.run(makeNode(chain), async (n, s) => {
            if (n === 1) {
                Object.assign(h.tracker.historyBackfill.options, { chunkBlocks: 2, pauseMs: 500 });
                await h.tracker.getNativeHistory(addresses, { limit: 100 }, { ip: 'test' });
                await until(() => h.tracker.historyWatch.get(first).progress.next > 1);
                await h.tracker.historyBackfill.stop();
                s.resumedFrom = (await h.tracker.db.getHistoryWatchRecords()).get(first).progress.next;
                await h.tracker.initNativeHistory();
                return null;
            }
            await until(allComplete(h.tracker, addresses));
            return 'stop';
        }, { inspect: async (s) => { s.rows = await rowsByAddress(h.tracker.db, addresses); } });
        expect(rebuilt.resumedFrom).to.be.within(2, 12);
        expect(rebuilt.rows).to.deep.equal(live.rows);
    });
});

describe('native history backfill: a reorg under an unfinished backfill', function () {
    const h = useSyncLoopHarness();
    this.timeout(30000);

    it('restarts the address below the fork and ends with the replacement chain\'s rows', async function () {
        const address = coinbaseAddress(9, 0);
        const finalChain = buildChain(16, 7, buildChain(13), 10);
        watchFromGenesis(h, [address]);
        const live = await h.run(makeNode(finalChain), (n) => (n >= 2 ? 'stop' : null), {
            inspect: async (s) => { s.rows = await rowsByAddress(h.tracker.db, [address]); }
        });
        h.seedMainStore(async () => {});
        const node = makeNode(buildChain(13));
        const hex = scriptOf(address).toString('hex');
        const seen = await h.run(node, async (n) => {
            if (n === 1) {
                Object.assign(h.tracker.historyBackfill.options, { chunkBlocks: 2, pauseMs: 300, retryMs: 50 });
                await h.tracker.getNativeHistory([address], { limit: 100 }, { ip: 'test' });
                await until(() => h.tracker.historyWatch.get(hex).progress.next > 10);
                node.retired = node.chain;
                node.chain = finalChain;
                return null;
            }
            await until(allComplete(h.tracker, [address]));
            return 'stop';
        }, { inspect: async (s) => { s.rows = await rowsByAddress(h.tracker.db, [address]); } });
        expect(h.tracker.reorgCount).to.equal(1);
        expect(h.tracker.historyWatch.get(hex).epoch).to.equal(1);
        expect(seen.rows).to.deep.equal(live.rows);
    });
});

describe('native history backfill: chunks scanned before a restart', function () {
    it('are refused at commit, and the restarted scan\'s are written', async function () {
        const writes = [];
        const tracker = { db: {
            getBackfillBlockChecks: async () => [{ height: 5, inWindow: true }],
            writeHistoryBackfill: async (rows, progress) => { writes.push(progress.length); },
        } };
        const entry = { buf: Buffer.alloc(32, 1), epoch: 1, progress: { next: 5, done: false, open: [] } };
        const runner = new HistoryBackfill(tracker, { get: () => entry }, { openMax: 10 });
        const work = [{ hex: entry.buf.toString('hex'), buf: entry.buf, epoch: 0, next: 6, open: new Map() }];
        expect(await runner.commitChunk([{ hash: 'ab'.repeat(32), height: 5 }], [], work)).to.equal(false);
        expect(writes).to.deep.equal([]);
        work[0].epoch = 1;
        expect(await runner.commitChunk([{ hash: 'ab'.repeat(32), height: 5 }], [], work)).to.equal(true);
        expect(writes).to.deep.equal([1]);
    });
});
