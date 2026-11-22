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

// A real tracker over an in-memory store, served by the real createApp, with
// watched addresses' history seeded through the store's own block-batch writer.
// The backfill runner is replaced by a recorder here; the suites that exercise
// the runner drive the real sync loop instead (history_backfill.test.js).

const crypto = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const XChainUtxoTracker = require('../../../../src/XChainUtxoTracker');
const LevelUpStore = require('../../../../src/store/level_up_db');
const { createTestApp } = require('../../api.test/support/test_app');

const NETWORK = 'bitcoin-regtest';

// A distinct regtest P2PKH address per index.
function addressFor(i) {
    const hash = crypto.createHash('sha256').update('history-address-' + i).digest().subarray(0, 20);
    return bitcoin.payments.p2pkh({ hash, network: bitcoin.networks.regtest }).address;
}

function scriptHashFor(address) {
    const script = bitcoin.address.toOutputScript(address, bitcoin.networks.regtest);
    return crypto.createHash('sha256').update(script).digest();
}

function txidFor(label) {
    return crypto.createHash('sha256').update('tx-' + label).digest('hex');
}

function blockHashFor(height) {
    return crypto.createHash('sha256').update('block-' + height).digest('hex');
}

// Opens the stores, loads the (empty) watch list and swaps the backfill runner
// for a recorder: `tracker.enqueued` lists every address handed to it.
async function createHistoryTracker(historyOptions = {}) {
    const tracker = new XChainUtxoTracker(NETWORK, '127.0.0.1', '18443', 'u', 'p', 'history-test', false);
    tracker.db = new LevelUpStore('history-test-' + Math.random(), true);
    tracker.mempoolDb = new LevelUpStore('mempool-history-test-' + Math.random(), true);
    await tracker.db.createDatabase();
    await tracker.mempoolDb.createDatabase();
    tracker.historyOptions = historyOptions;
    await initRecordedHistory(tracker);
    return tracker;
}

async function initRecordedHistory(tracker) {
    await tracker.initNativeHistory();
    tracker.enqueued = [];
    tracker.historyBackfill.enqueueMany = (hexes) => { tracker.enqueued.push(...hexes); return hexes.length; };
}

// Watches `addresses` with their past already complete from height 0 and live
// from height 0, as a store that has watched them since genesis holds them.
async function watchComplete(tracker, addresses) {
    await tracker.db.addHistoryWatches(addresses.map((a) => ({
        script: scriptHashFor(a), start: 0, progress: { next: 0, done: true, open: [] } })));
    for (const a of addresses) await tracker.db.setHistoryLiveFrom(scriptHashFor(a), 0, { staged: false });
    await initRecordedHistory(tracker);
}

// Commits one block holding `moves` ([{ address, txid, received, sent }]) as the
// sync loop would: B staged first, the watch snapshot taken, then each movement,
// then the tip, one batch.
async function commitBlock(tracker, height, time, moves) {
    const db = tracker.db;
    const hash = blockHashFor(height);
    await db.beginTransaction();
    await db.insertBlock({ hash, height, timestamp: time, previousHash: blockHashFor(height - 1) });
    db.historyScripts = tracker.historyWatch.scripts;
    for (const m of moves) {
        await db.addHistoryMovement({
            script: scriptHashFor(m.address), blockHash: hash, txid: m.txid,
            received: BigInt(m.received || 0), sent: BigInt(m.sent || 0)
        });
    }
    await db.setLastBlockHeight(height);
    await db.setLastBlockHash(hash);
    await db.endTransaction();
}

function createHistoryApp(tracker) {
    return createTestApp(tracker);
}

async function closeTracker(tracker) {
    try { await tracker.stopNativeHistory(); } catch (e) { /* never started */ }
    try { await tracker.db.close(); } catch (e) { /* already closed */ }
    try { await tracker.mempoolDb.close(); } catch (e) { /* already closed */ }
}

module.exports = {
    addressFor, scriptHashFor, txidFor, blockHashFor,
    createHistoryTracker, watchComplete, commitBlock, createHistoryApp, closeTracker
};
