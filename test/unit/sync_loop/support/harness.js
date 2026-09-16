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

// Drives the block sync loop end to end: start() against a scripted node and
// in-memory stores. A case scripts the node's chain between the loop's sleeps
// and reads the committed store and the tracker's health fields, so the loop's
// steps (tip refresh, catch-up wait, rollbacks, staging, flush) run as they do
// against a live node, with no node and no disk.

const crypto = require('crypto');
const sinon = require('sinon');
const bitcoin = require('bitcoinjs-lib');
const LevelUpStore = require('../../../../src/store/level_up_db');
const XChainUtxoTracker = require('../../../../src/XChainUtxoTracker');

// A regtest block at `height` on top of `prevId`: a coinbase paying two
// outputs, plus one spend of an earlier coinbase output when given. `tag`
// separates competing chains at the same height.
function makeBlock(prevId, height, tag, spends) {
    const coinbase = new bitcoin.Transaction();
    coinbase.version = 1;
    coinbase.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, Buffer.from([height & 0xff, (height >> 8) & 0xff, tag]));
    const keyHash = crypto.createHash('sha256').update('k' + height + ':' + tag).digest().subarray(0, 20);
    coinbase.addOutput(bitcoin.payments.p2pkh({ hash: keyHash }).output, 5000000000);
    coinbase.addOutput(bitcoin.payments.p2wpkh({ hash: keyHash }).output, 1000);
    const txs = [coinbase];
    for (const s of spends) {
        const tx = new bitcoin.Transaction();
        tx.version = 2;
        tx.addInput(Buffer.from(s.txid, 'hex').reverse(), s.vout, 0xffffffff, Buffer.from([0x51]));
        const spendHash = crypto.createHash('sha256').update('s' + height + ':' + tag + s.txid).digest().subarray(0, 20);
        tx.addOutput(bitcoin.payments.p2pkh({ hash: spendHash }).output, 4000000000);
        txs.push(tx);
    }
    const block = new bitcoin.Block();
    block.version = 0x20000000;
    block.prevHash = prevId ? Buffer.from(prevId, 'hex').reverse() : Buffer.alloc(32);
    block.merkleRoot = bitcoin.Block.calculateMerkleRoot(txs);
    block.timestamp = 1600000000 + height * 600 + tag;
    block.bits = 0x207fffff;
    block.nonce = tag;
    block.transactions = txs;
    return { hash: block.getId(), hex: block.toHex(), coinbase: coinbase.getId() };
}

// Heights [from, length) built on `base`, keeping base's blocks below `from`.
// Every odd height from 3 spends the coinbase two blocks down.
function buildChain(length, tag = 0, base = [], from = 0) {
    const chain = base.slice(0, from);
    for (let h = from; h < length; h++) {
        const spends = (h >= 3 && h % 2 === 1) ? [{ txid: chain[h - 2].coinbase, vout: 0 }] : [];
        chain.push(makeBlock(h === 0 ? null : chain[h - 1].hash, h, tag, spends));
    }
    return chain;
}

// A node serving `node.chain`. `faults[method]` queues errors thrown in order
// (null lets one call through), `retired` keeps replaced blocks fetchable by
// hash, and `onBatch` sees every batched fetch before it is answered.
function makeNode(chain) {
    const node = { chain, ibd: false, progress: 1, faults: {}, onBatch: null, reassembled: 0, infoCalls: 0, retired: [] };
    const fault = (m) => { const q = node.faults[m]; if (q && q.length) { const e = q.shift(); if (e) throw e; } };
    const at = (h) => { if (h < 0 || h >= node.chain.length) throw new Error('height out of range ' + h); return node.chain[h]; };
    const byHash = (hash) => {
        const b = node.chain.find((x) => x.hash === hash) || node.retired.find((x) => x.hash === hash);
        if (!b) throw new Error('block not found ' + hash);
        return b;
    };
    node.connector = {
        async getBlockchainInfo() {
            node.infoCalls++;
            fault('info');
            return { blocks: node.chain.length - 1, verificationprogress: node.progress, initialblockdownload: node.ibd };
        },
        async getBlockHash(h) { fault('hash'); return at(h).hash; },
        async getBlock(hash) { return byHash(hash).hex; },
        async getBlockWithoutAuxPow(hash) { return byHash(hash).hex; },
        async getBlocksBatch(hs) { if (node.onBatch) node.onBatch(hs); fault('batch'); return hs.map((h) => at(h)); },
        async getBlocksBatchWithoutAuxPow(hs) { fault('batch'); return hs.map((h) => at(h)); },
        async getBlockReassembled(hash) { node.reassembled++; return byHash(hash).hex; },
    };
    return node;
}

// Runs start() with `node` behind it. `onSleep(n, seen)` runs at the loop's
// n-th sleep and may script the node; returning 'stop' ends the loop there,
// after the open store's tip (and anything `inspect` reads) lands in `seen`.
async function runLoop(h, node, onSleep, { network = 'bitcoin-regtest', inspect } = {}) {
    const tracker = new XChainUtxoTracker(network, '127.0.0.1', 1, 'u', 'p', 'sync-loop-' + Math.random(), false);
    h.tracker = tracker;
    tracker.connector = node.connector;
    tracker.mempoolPolls = 0;
    tracker.updateMempool = async function () { this.mempoolPolls++; };
    const seen = {};
    let sleeps = 0;
    tracker.sleep = async function (ms) {
        sleeps++;
        h.clock += ms;
        await new Promise((resolve) => setImmediate(resolve));
        const verdict = sleeps > 400 ? 'stop' : await onSleep(sleeps, seen);
        if (verdict === 'stop') {
            seen.height = await tracker.db.getLastBlockHeight();
            seen.hash = await tracker.db.getLastBlockHash();
            if (inspect) await inspect(seen);
            tracker.keepParsing = false;
        }
    };
    await tracker.start();
    return seen;
}

// Installs the per-case stubs on the calling describe (a clock the sleeps
// advance, in-memory stores, a quiet console) and returns the handle the
// cases drive.
function useSyncLoopHarness() {
    const h = { tracker: null, clock: 0 };
    beforeEach(function () {
        h.clock = 1700000000000;
        sinon.stub(Date, 'now').callsFake(() => h.clock);
        const open = LevelUpStore.prototype.createDatabase;
        sinon.stub(LevelUpStore.prototype, 'createDatabase').callsFake(function () {
            this.inMemory = true;
            return open.call(this);
        });
        for (const m of ['log', 'info', 'warn', 'error']) sinon.stub(console, m);
    });
    afterEach(async function () {
        sinon.restore();
        if (h.tracker && h.tracker.mempoolInterval) clearInterval(h.tracker.mempoolInterval);
        try { await h.tracker.db.close(); } catch (e) { /* the loop already closed it */ }
        h.tracker = null;
    });
    h.run = (node, onSleep, opts) => runLoop(h, node, onSleep, opts);
    // Seeds every main store as it opens, for the boot-state cases.
    h.seedMainStore = (seed) => {
        const open = LevelUpStore.prototype.createDatabase.wrappedMethod;
        LevelUpStore.prototype.createDatabase.callsFake(async function () {
            this.inMemory = true;
            const db = await open.call(this);
            if (!this.dbName.startsWith('mempool')) await seed(this);
            return db;
        });
    };
    return h;
}

module.exports = { buildChain, makeNode, useSyncLoopHarness };
