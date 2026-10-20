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

// Regression: an address read must never straddle a block flush.
//
// A block flush commits the confirmed batch and then deletes the mined txs'
// mempool records. get_info and get_utxos read the confirmed store first and
// the mempool store after. A read whose confirmed snapshot predates the
// commit and whose mempool reads follow the cleanup would see a just-mined
// output in neither store, and would serve the confirmed outpoint that block
// spent as an unspent coin. These tests pause a reader after each of its store
// reads in turn, run a full flush while it is paused, then let it finish, and
// check the read is consistent with one side of the block or the other.

const { expect } = require('chai');
const crypto = require('crypto');
const { createHash } = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const XChainUtxoTracker = require('../../../src/XChainUtxoTracker');
const LevelUpStore = require('../../../src/store/level_up_db');
const { flushBatch } = require('../../../src/XChainUtxoTracker/sync_loop_block_apply.js');

const ADDR_W = 'n1wgm6kkzMcNfAtJmes8YhpvtDzdNhDY5a';
const ADDR_X = 'mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn';

const FUND_VALUE = 150000000n;   // the confirmed W coin Tout spends
const OTHER_VALUE = 150000000n;  // a second confirmed W coin nothing spends
const TIN_VALUE = 700000000n;    // Tin pays W
const TOUT_VALUE = 100000000n;   // Tout pays X
const CHANGE_VALUE = 40000000n;  // a refresh scenario's spend pays W back

let dbCounter = 0;
function uniqueDbName(prefix) { return prefix + '-tear-' + Date.now() + '-' + (++dbCounter); }
function randHash() { return crypto.randomBytes(32).toString('hex'); }

function scriptHashOf(address, network) {
    const script = bitcoin.address.toOutputScript(address, network);
    return createHash('sha256').update(script).digest('hex');
}

function deferred() {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    return { promise, resolve };
}

async function putConfirmedOutput(db, scriptHash, txid, vout, value, height) {
    const txHash8 = txid.substring(0, 16);
    await db.insertOutput({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: vout, value, height, fullTxHash: txid });
    await db.insertOutputHint({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: vout });
}

async function putMempoolOutput(mempoolDb, scriptHash, txid, vout, value) {
    const txHash8 = txid.substring(0, 16);
    await mempoolDb.insertOutput({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: vout, value, height: -1, fullTxHash: txid });
    await mempoolDb.insertOutputHint({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: vout });
}

// One scenario: W holds two confirmed coins (fund:0 and other:0). The mempool
// holds Tin (pays W) and Tout (spends fund:0, pays X). The next block mines
// both, and its batch is staged but not yet committed.
async function makeScenario() {
    const tracker = new XChainUtxoTracker('bitcoin-regtest', '127.0.0.1', '18443', 'user', 'pass', 'test-db', false);
    const db = new LevelUpStore(uniqueDbName('confirmed'), true);
    const mempoolDb = new LevelUpStore(uniqueDbName('mempool'), true);
    await db.createDatabase();
    await mempoolDb.createDatabase();
    tracker.db = db;
    tracker.mempoolDb = mempoolDb;
    tracker.blockchainInfoLastBlock = 102;
    tracker.sleep = (ms) => new Promise(r => setTimeout(r, ms));

    const shW = scriptHashOf(ADDR_W, tracker.network);
    const shX = scriptHashOf(ADDR_X, tracker.network);
    const fund = randHash();
    const other = randHash();
    const tin = randHash();
    const tout = randHash();
    const blockHash = randHash();

    await db.beginTransaction();
    await putConfirmedOutput(db, shW, fund, 0, FUND_VALUE, 50);
    await putConfirmedOutput(db, shW, other, 0, OTHER_VALUE, 50);
    await db.endTransaction(true);

    await mempoolDb.beginTransaction();
    await mempoolDb.insertTransaction({ hash: tin, blockHash: null });
    await putMempoolOutput(mempoolDb, shW, tin, 0, TIN_VALUE);
    await mempoolDb.insertTransaction({ hash: tout, blockHash: null });
    await putMempoolOutput(mempoolDb, shX, tout, 0, TOUT_VALUE);
    const spend = { prevTxHash: fund, prevOutputIndex: 0, txHash: tout.substring(0, 16) };
    await mempoolDb.insertInput(spend);
    await mempoolDb.insertInputHint(spend);
    await mempoolDb.endTransaction(true);

    // The block's staged batch: Tin:0 and Tout:0 created, fund:0 spent.
    await db.beginTransaction();
    await putConfirmedOutput(db, shW, tin, 0, TIN_VALUE, 102);
    await putConfirmedOutput(db, shX, tout, 0, TOUT_VALUE, 102);
    await db.removeOutputsWithInputsBatch([{ prevTxHash: fund.substring(0, 16), prevOutputIndex: 0, blockHash }]);

    const sync = {
        _t: { commit: 0, cleanup: 0 },
        pendingMempoolTxCleanup: [tin, tout],
        blocksCount: 1, transactionsCount: 2, inputsCount: 1, outputsCount: 2,
    };
    const flush = { reason: 'tip', heapMB: 0 };
    const runFlush = () => flushBatch.call(tracker, sync, flush, blockHash, 102);

    return { tracker, db, mempoolDb, fund, other, tin, runFlush };
}

const STORE_READS = ['getOutputsScriptPubKey', 'getInput', 'hasOutputForTx'];

// Pauses the reader right after its k-th store read (counting reads on both
// stores). Only reads issued while `armed` count, so the flush's own store
// traffic never trips the gate.
function gateReaderAfterRead(scenario, k) {
    const state = { armed: true, count: 0, paused: deferred(), release: deferred(), hit: false };
    for (const store of [scenario.db, scenario.mempoolDb]) {
        for (const name of STORE_READS) {
            const original = store[name].bind(store);
            store[name] = async (...args) => {
                const result = await original(...args);
                if (state.armed && ++state.count === k) {
                    state.armed = false;
                    state.hit = true;
                    state.paused.resolve();
                    await state.release.promise;
                }
                return result;
            };
        }
    }
    return state;
}

// Runs `read` with the reader paused after its k-th store read while a writer
// (a full flush unless given) is started, then releases it. Returns null when
// the read finished before reaching read k (every pause point has been covered).
async function interleave(scenario, k, read, write = scenario.runFlush) {
    const gate = gateReaderAfterRead(scenario, k);
    const readPromise = read();
    const finishedFirst = await Promise.race([
        gate.paused.promise.then(() => false),
        readPromise.then(() => true),
    ]);
    if (finishedFirst && !gate.hit) {
        // Disarm first so the writer's own store reads never trip the gate.
        gate.armed = false;
        await write();
        return null;
    }
    const writePromise = write();
    // Give the writer every chance to commit while the reader is parked
    // between its snapshots.
    await Promise.race([writePromise, new Promise(r => setTimeout(r, 100))]);
    gate.release.resolve();
    const [result] = await Promise.all([readPromise, writePromise]);
    return result;
}

async function closeScenario(scenario) {
    try { await scenario.db.close(); } catch (_) {}
    try { await scenario.mempoolDb.close(); } catch (_) {}
}

function sumSats(values) { return values.reduce((a, v) => a + BigInt(v), 0n); }

async function utxosNeverStraddle() {
    let covered = 0;
    for (let k = 1; k <= 20; k++) {
        const scenario = await makeScenario();
        try {
            const utxos = await interleave(scenario, k, () => scenario.tracker.getUtxosAddress(ADDR_W));
            if (utxos === null) break;
            covered++;
            const keys = utxos.map(u => u.txid + ':' + u.vout);
            const label = 'pause after read ' + k + ': ' + JSON.stringify(keys);
            expect(keys.filter(x => x === scenario.tin + ':0'), label).to.have.length(1);
            expect(keys, label).to.not.include(scenario.fund + ':0');
            expect(keys, label).to.include(scenario.other + ':0');
            expect(sumSats(utxos.map(u => u.value)), label).to.equal(OTHER_VALUE + TIN_VALUE);
        } finally {
            await closeScenario(scenario);
        }
    }
    expect(covered, 'pause points exercised').to.be.at.least(3);
}

async function balanceNeverStraddles() {
    // Before the block: confirmed fund + other, pending +Tin -fund.
    // After the block: confirmed other + Tin, pending 0. Both net to
    // other + Tin, which is what a reader on either side must report.
    const want = OTHER_VALUE + TIN_VALUE;
    let covered = 0;
    for (let k = 1; k <= 20; k++) {
        const scenario = await makeScenario();
        try {
            const info = await interleave(scenario, k, () => scenario.tracker.getBalanceInfo(ADDR_W));
            if (info === null) break;
            covered++;
            const toSats = (s) => BigInt(s.replace('.', ''));
            const total = toSats(info.balances.confirmed) + toSats(info.balances.pending);
            expect(total, 'pause after read ' + k + ': ' + JSON.stringify(info.balances)).to.equal(want);
        } finally {
            await closeScenario(scenario);
        }
    }
    expect(covered, 'pause points exercised').to.be.at.least(3);
}

async function readWaitsForFlush() {
    const scenario = await makeScenario();
    try {
        const begin = scenario.mempoolDb.beginTransaction.bind(scenario.mempoolDb);
        const inCleanup = deferred();
        const resume = deferred();
        scenario.mempoolDb.beginTransaction = async (...args) => {
            inCleanup.resolve();
            await resume.promise;
            return begin(...args);
        };
        const flushPromise = scenario.runFlush();
        await inCleanup.promise;
        const readPromise = scenario.tracker.getUtxosAddress(ADDR_W);
        await new Promise(r => setTimeout(r, 20));
        resume.resolve();
        const [utxos] = await Promise.all([readPromise, flushPromise]);
        const keys = utxos.map(u => u.txid + ':' + u.vout);
        expect(keys.filter(x => x === scenario.tin + ':0')).to.have.length(1);
        expect(keys).to.not.include(scenario.fund + ':0');
        // The read ran after the flush: every coin is confirmed now.
        expect(utxos.every(u => u.height !== null && u.confirmations > 0), JSON.stringify(utxos)).to.equal(true);
    } finally {
        await closeScenario(scenario);
    }
}

// A tracker over fresh in-memory stores where W holds one confirmed coin X,
// with a stubbed node for the mempool refresh to read.
async function makeRefreshTracker(fund, rawMempool, rawTxsHex) {
    const tracker = new XChainUtxoTracker('bitcoin-regtest', '127.0.0.1', '18443', 'user', 'pass', 'test-db', false);
    const db = new LevelUpStore(uniqueDbName('confirmed'), true);
    const mempoolDb = new LevelUpStore(uniqueDbName('mempool'), true);
    await db.createDatabase();
    await mempoolDb.createDatabase();
    Object.assign(tracker, { db, mempoolDb, blockchainInfoLastBlock: 102, mempoolBusy: false });
    tracker.sleep = (ms) => new Promise(r => setTimeout(r, ms));
    // The node's tip is the committed tip, so the refresh's prune may evict.
    const tipHash = randHash();
    tracker.connector = {
        getRawMempool: async () => rawMempool, getRawTransactions: async () => rawTxsHex,
        getBlockchainInfo: async () => ({ blocks: 102, bestblockhash: tipHash }),
    };
    await db.beginTransaction();
    await putConfirmedOutput(db, scriptHashOf(ADDR_W, tracker.network), fund, 0, FUND_VALUE, 50);
    await db.setLastBlockHeight(102);
    await db.setLastBlockHash(tipHash);
    await db.endTransaction(true);
    return { tracker, db, mempoolDb, fund, runRefresh: () => tracker.updateMempool() };
}

// Prune: the store holds T (spends X, pays CHANGE back to W) and the node has
// dropped T, so the refresh evicts it. Before: Y only. After: X only.
async function makePruneScenario() {
    const scenario = await makeRefreshTracker(randHash(), [], []);
    const { mempoolDb, fund, tracker } = scenario;
    const t = randHash();
    await mempoolDb.beginTransaction();
    await mempoolDb.insertTransaction({ hash: t, blockHash: null });
    await putMempoolOutput(mempoolDb, scriptHashOf(ADDR_W, tracker.network), t, 0, CHANGE_VALUE);
    const spend = { prevTxHash: fund, prevOutputIndex: 0, txHash: t.substring(0, 16) };
    await mempoolDb.insertInput(spend);
    await mempoolDb.insertInputHint(spend);
    await mempoolDb.endTransaction(true);
    const sides = [{ keys: [t + ':0'], total: CHANGE_VALUE }, { keys: [fund + ':0'], total: FUND_VALUE }];
    return { ...scenario, sides };
}

// Stage: the store is empty and the node lists a real T spending X and paying
// CHANGE back to W, so the refresh stages it. Before: X only. After: Y only.
async function makeStageScenario() {
    const fund = randHash();
    const tx = new bitcoin.Transaction();
    tx.addInput(Buffer.from(fund, 'hex').reverse(), 0);
    tx.addOutput(bitcoin.address.toOutputScript(ADDR_W, bitcoin.networks.regtest), Number(CHANGE_VALUE));
    const scenario = await makeRefreshTracker(fund, [tx.getId()], [tx.toHex()]);
    const sides = [{ keys: [fund + ':0'], total: FUND_VALUE }, { keys: [tx.getId() + ':0'], total: CHANGE_VALUE }];
    return { ...scenario, sides };
}

// One pause-point sweep of a mempool refresh against one kind of read; the
// read must land wholly on one side of the refresh at every pause point.
async function refreshNeverTears(makeRefreshScenario, read, sideOf) {
    let covered = 0;
    for (let k = 1; k <= 20; k++) {
        const scenario = await makeRefreshScenario();
        try {
            const got = await interleave(scenario, k, () => read(scenario.tracker), scenario.runRefresh);
            if (got === null) break;
            covered++;
            const label = 'pause after read ' + k + ': ' + JSON.stringify(sideOf(got));
            expect(scenario.sides.map(s => JSON.stringify(sideOf(s, true))), label).to.include(JSON.stringify(sideOf(got)));
        } finally {
            await closeScenario(scenario);
        }
    }
    expect(covered, 'pause points exercised').to.be.at.least(3);
}

// The outpoints a get_utxos result serves, or a scenario side's own set.
function utxoSide(got, isSide) {
    return isSide ? got.keys.slice().sort() : got.map(u => u.txid + ':' + u.vout).sort();
}

// Confirmed plus pending of a get_info result, or a scenario side's total.
function balanceSide(got, isSide) {
    if (isSide) return String(got.total);
    const toSats = (s) => BigInt(s.replace('.', ''));
    return String(toSats(got.balances.confirmed) + toSats(got.balances.pending));
}

const readUtxos = (tracker) => tracker.getUtxosAddress(ADDR_W);
const readBalance = (tracker) => tracker.getBalanceInfo(ADDR_W);

describe('Regression: address reads never straddle a block flush', function () {
    this.timeout(30000);

    it('get_utxos serves Tin:0 exactly once and never the spent outpoint, at every pause point', utxosNeverStraddle);

    it('get_info confirmed plus pending is the same before and after the block, at every pause point', balanceNeverStraddles);

    it('a read started while the flush is between commit and cleanup waits for the flush', readWaitsForFlush);
});

describe('Regression: address reads never straddle a mempool refresh commit', function () {
    this.timeout(30000);

    it('get_utxos sees all or none of a prune that evicts a spend, at every pause point', () => refreshNeverTears(makePruneScenario, readUtxos, utxoSide));

    it('get_info sees all or none of a prune that evicts a spend, at every pause point', () => refreshNeverTears(makePruneScenario, readBalance, balanceSide));

    it('get_utxos sees all or none of a staged spend, at every pause point', () => refreshNeverTears(makeStageScenario, readUtxos, utxoSide));

    it('get_info sees all or none of a staged spend, at every pause point', () => refreshNeverTears(makeStageScenario, readBalance, balanceSide));
});
