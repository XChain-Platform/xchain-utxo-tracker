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

const crypto = require('crypto');
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

function taggedStripError(message) {
    const err = new Error(message);
    err.auxPowParseFailure = true;
    return err;
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

describe('native history backfill: fetching blocks', function () {
    it('reassembles a block whose batch and strip fetches both fail on a parse fault', async function () {
        const node = makeNode(buildChain(3));
        node.faults.batch = [taggedStripError('batch strip failed')];
        node.faults.strip = [taggedStripError('block strip failed')];
        const runner = new HistoryBackfill({ connector: node.connector, auxPow: true }, null, {});
        const fetched = await runner.fetchBlocks([0, 1, 2]);
        expect(node.reassembled).to.equal(1);
        expect(fetched.map((block) => block.height)).to.deep.equal([0, 1, 2]);
        expect(fetched.map((block) => block.hash)).to.deep.equal(node.chain.map((block) => block.hash));
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

// A synthetic chain for one deep address: block 0 pays it `fund` outputs that
// stay open, `extra` adds more movements by height ({ receive } pays one more
// output, { spend: [[txid, vout]] } spends some), every other block is empty.
const DEEP_SCRIPT = Buffer.from('76a914' + '11'.repeat(20) + '88ac', 'hex');
const DEEP_BUF = crypto.createHash('sha256').update(DEEP_SCRIPT).digest();
const OTHER_SCRIPT = Buffer.from('76a914' + '22'.repeat(20) + '88ac', 'hex');

function labelTxid(label) {
    return crypto.createHash('sha256').update('deep-' + label).digest('hex');
}

function fakeTx(txid, ins, outs) {
    return { getId: () => txid, ins, outs };
}

function spendInput([txid, index]) {
    return { hash: Buffer.from(txid, 'hex').reverse(), index };
}

function deepChain(blocks, fund, extra = {}) {
    const chain = [];
    for (let h = 0; h < blocks; h++) {
        const txs = [];
        if (h === 0) txs.push(fakeTx(labelTxid('fund'), [], Array.from({ length: fund }, () => ({ script: DEEP_SCRIPT, value: 1000 }))));
        const e = extra[h];
        if (e && e.receive) txs.push(fakeTx(labelTxid('receive-' + h), [], [{ script: DEEP_SCRIPT, value: 7 }]));
        if (e && e.spend) txs.push(fakeTx(labelTxid('spend-' + h), e.spend.map(spendInput), [{ script: OTHER_SCRIPT, value: 1 }]));
        chain.push({ timestamp: 1000 + h, transactions: txs });
    }
    return chain;
}

function hashAt(h) {
    return crypto.createHash('sha256').update('deep-block-' + h).digest('hex');
}

// A store that keeps rows and the stored PROGRESS record as the level store
// would (the record as its JSON bytes) and counts every PROGRESS byte written.
function deepStore(tip) {
    const store = { rows: new Map(), stored: null, progressBytes: 0, progressPuts: 0 };
    store.db = {
        getLastBlockHeight: async () => tip,
        getBackfillBlockChecks: async (hashes) => hashes.map((hash) => ({ height: Number(hash.slice(64)), inWindow: false })),
        writeHistoryBackfill: async (rows, progress) => {
            for (const r of rows) store.rows.set(r.height + ':' + r.txid, [r.received.toString(), r.sent.toString(), r.time]);
            for (const { record } of progress) {
                const json = JSON.stringify(record);
                store.stored = json;
                store.progressBytes += Buffer.byteLength(json);
                store.progressPuts++;
            }
        },
    };
    return store;
}

function deepRunner(chain, store, progress, options = {}) {
    const entry = { buf: DEEP_BUF, start: 0, liveFrom: chain.length, progress, epoch: 0 };
    const tracker = {
        db: store.db, halted: false, parsingAborted: false,
        xchainBlockDecoder: { blockFromHex: (hex) => chain[Number(hex)] },
    };
    const runner = new HistoryBackfill(tracker, { get: () => entry },
        { chunkBlocks: 10, pauseMs: 0, waitMs: 0, retryMs: 0, openMax: 100000, ...options });
    // The hash carries its height after the 64 hex digits, for the store's block check.
    runner.fetchBlocks = async (heights) => heights.map((h) => ({ hex: String(h), hash: hashAt(h) + h }));
    return { runner, entry };
}

async function backfillDeep(blocks, fund, extra, options) {
    const store = deepStore(blocks - 1);
    const { runner } = deepRunner(deepChain(blocks, fund, extra), store, { next: 0, done: false, open: [] }, options);
    await runner.passLoop([DEEP_BUF.toString('hex')]);
    return store;
}

// The bytes of one progress record holding `fund` open outputs.
function fullRecordBytes(fund) {
    const txid = labelTxid('fund');
    return Buffer.byteLength(JSON.stringify({ next: 0, done: false,
        open: Array.from({ length: fund }, (_, i) => [txid + ':' + i, '1000']) }));
}

describe('native history backfill: progress writes for a deep address', function () {
    this.timeout(60000);

    it('writes progress bytes bounded per block scanned, not open outputs times chunks', async function () {
        const fund = 2000;
        for (const blocks of [200, 400]) {
            const store = await backfillDeep(blocks, fund);
            expect(JSON.parse(store.stored)).to.deep.equal({ next: blocks, done: true, open: [] });
            // Every chunk rewriting the open set would be blocks / 10 full records.
            expect(store.progressBytes).to.be.at.most(fullRecordBytes(fund) * (blocks * 50 / fund + 2));
        }
    });

    it('does not grow the progress bytes with the open set at a fixed chain length', async function () {
        const small = await backfillDeep(200, 1000);
        const large = await backfillDeep(200, 4000);
        expect(large.progressBytes).to.be.below(small.progressBytes * 2);
    });

    it('stores an unavailable record with the chunk that crosses the ceiling', async function () {
        const store = await backfillDeep(200, 2000, {}, { openMax: 500 });
        expect(store.progressPuts).to.equal(1);
        expect(JSON.parse(store.stored)).to.deep.equal({ next: 10, done: false, unavailable: true, open: [] });
    });

    it('resumes from a lagging checkpoint to the same rows as an uninterrupted walk', async function () {
        const fund = 2000;
        const fundTxid = labelTxid('fund');
        // Paid one more output at 85, after a checkpoint; spent with ten funded ones at 150.
        const extra = {
            85: { receive: true },
            150: { spend: [[labelTxid('receive-85'), 0], ...Array.from({ length: 10 }, (_, i) => [fundTxid, i])] },
        };
        const whole = await backfillDeep(200, fund, extra);

        const chain = deepChain(200, fund, extra);
        const store = deepStore(199);
        const first = deepRunner(chain, store, { next: 0, done: false, open: [] });
        let chunks = 0;
        const write = store.db.writeHistoryBackfill;
        store.db.writeHistoryBackfill = async (rows, progress) => {
            await write(rows, progress);
            // Stops as a crash would after the chunk ending at block 99.
            if (++chunks === 10) first.runner.stopped = true;
        };
        await first.runner.passLoop([DEEP_BUF.toString('hex')]);
        const resumedFrom = JSON.parse(store.stored);
        expect(first.entry.progress.next).to.equal(100);
        expect(resumedFrom.next).to.be.below(85);

        store.db.writeHistoryBackfill = write;
        const second = deepRunner(chain, store, resumedFrom);
        await second.runner.passLoop([DEEP_BUF.toString('hex')]);
        expect(JSON.parse(store.stored)).to.deep.equal({ next: 200, done: true, open: [] });
        expect(store.rows).to.deep.equal(whole.rows);
        expect(store.rows.get('150:' + labelTxid('spend-150'))).to.deep.equal(['0', String(7 + 10 * 1000), 1150]);
    });
});
