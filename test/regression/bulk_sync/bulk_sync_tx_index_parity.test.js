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

// Regression: non-Bitcoin bulk seeds write the live tx index.
//
// The live confirmed path writes a 64-byte T, an exact-txid X and a per-block Y
// for every transaction (insertTransaction), and prunes Y past the undo window.
// These tests seed the same transactions through deriveKeys/loadKeys and require
// byte-identical T/X/Y records to a live store, including a shared 8-byte prefix
// collision across blocks, then read the seed back through get_tx_block's store
// method and through a rollback of the seeded tip block.

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const crypto = require('crypto');
const { expect } = require('chai');
const { ClassicLevel } = require('classic-level');

const { OutputsWriter, SpendsWriter, MetaWriter } = require('../../../src/bulk_sync/writers.js');
const { externalSort }   = require('../../../src/bulk_sync/merger/external_sort.js');
const { leftAntiJoin }   = require('../../../src/bulk_sync/merger/streaming_join.js');
const { deriveKeys }     = require('../../../src/bulk_sync/merger/derive_keys.js');
const { loadKeys }       = require('../../../src/bulk_sync/merger/loader.js');
const LevelUpStore       = require('../../../src/store/level_up_db');

const OUTPUTS_KEY_SIZE = 12;
const SPENDS_KEY_SIZE  = 12;
const HEADER_SIZE      = 64;
const TX_PREFIXES      = new Set(['T', 'X', 'Y']);

function h32(label) { return crypto.createHash('sha256').update(label).digest(); }

const block1 = { height: 10, ts: 1700000000, hash: h32('ti-block-1'), prev: h32('ti-block-0') };
const block2 = { height: 11, ts: 1700000600, hash: h32('ti-block-2'), prev: block1.hash };
const block3 = { height: 12, ts: 1700001200, hash: h32('ti-block-3'), prev: block2.hash };

const TX_A = h32('ti-tx-a');
const TX_B = h32('ti-tx-b');
// Shares TX_A's 8-byte prefix but is a different transaction in a later block.
const TX_C = Buffer.concat([TX_A.subarray(0, 8), h32('ti-tx-c').subarray(8)]);
const TX_D = h32('ti-tx-d');

const SEEDED_TXS = [
    { txid: TX_A, block: block1, outputs: 2 },
    { txid: TX_B, block: block2, outputs: 1 },
    { txid: TX_C, block: block3, outputs: 1 },
    { txid: TX_D, block: block3, outputs: 3 },
];

function writeInputs(tmp) {
    const outputsPath = path.join(tmp, 'outputs.dat');
    const w = new OutputsWriter(outputsPath, 'dogecoin', 'regtest', block1.height, block3.height);
    // Later blocks first: the slot owner must come from the sort, not the file order.
    for (const t of SEEDED_TXS.slice().reverse()) {
        for (let v = 0; v < t.outputs; v++) {
            w.append(t.txid.subarray(0, 8), v, 1000n + BigInt(v), t.block.height, t.txid,
                h32('ti-script-' + t.txid.toString('hex') + v), t.block.hash, false);
        }
    }
    w.close();

    const spendsPath = path.join(tmp, 'spends.dat');
    const sp = new SpendsWriter(spendsPath, 'dogecoin', 'regtest', block1.height, block3.height);
    sp.append(TX_A.subarray(0, 8), 1, TX_B.subarray(0, 8));
    sp.close();

    const metaPath = path.join(tmp, 'meta.dat');
    const meta = new MetaWriter(metaPath, 'dogecoin', 'regtest', block1.height, block3.height);
    meta.writeBlock(block1.height, block1.ts, block1.hash, block1.prev, [TX_A.subarray(0, 8)]);
    meta.writeBlock(block2.height, block2.ts, block2.hash, block2.prev, [TX_B.subarray(0, 8)]);
    meta.writeBlock(block3.height, block3.ts, block3.hash, block3.prev, [TX_C.subarray(0, 8), TX_D.subarray(0, 8)]);
    meta.close();
    return { outputsPath, spendsPath, metaPath };
}

async function seed(tmp, deriveOpts, cleanupOutputs) {
    const { outputsPath, spendsPath, metaPath } = writeInputs(tmp);
    const outputsSorted = path.join(tmp, 'outputs-sorted.dat');
    const spendsSorted  = path.join(tmp, 'spends-sorted.dat');
    await externalSort({ inputPath: outputsPath, outputPath: outputsSorted, headerSize: HEADER_SIZE, recordSize: 121, keySize: OUTPUTS_KEY_SIZE, ramBudgetBytes: 1 << 20, tmpDir: path.join(tmp, 'so') });
    await externalSort({ inputPath: spendsPath,  outputPath: spendsSorted,  headerSize: HEADER_SIZE, recordSize: 20, keySize: SPENDS_KEY_SIZE, ramBudgetBytes: 1 << 20, tmpDir: path.join(tmp, 'ss') });
    const liveUtxos = path.join(tmp, 'live-utxos.dat');
    await leftAntiJoin({ leftPath: outputsSorted, rightPath: spendsSorted, outputPath: liveUtxos, leftRecordSize: 121, rightRecordSize: 20, keySize: OUTPUTS_KEY_SIZE });

    const keysDir = path.join(tmp, 'keys');
    const { stats } = await deriveKeys(Object.assign({
        metaPath, outputsPath, liveUtxosPath: liveUtxos, spendsByPrevPath: spendsSorted,
        outDir: keysDir, tmpDir: path.join(tmp, 'derive'),
        ramBudgetBytes: 1 << 20, network: 'dogecoin-regtest', undoBlocks: 2, outputsRecordSize: 121,
        onProgress(ev) {
            if (cleanupOutputs && ev.phase === 'script-cand-raw-done') fs.unlinkSync(outputsPath);
        },
    }, deriveOpts));
    return { keysDir, stats };
}

async function collectTxRecords(db) {
    const out = new Map();
    for await (const [key, value] of db.iterator({ keys: true, values: true })) {
        if (TX_PREFIXES.has(String.fromCharCode(key[0])) && key.length > 1) {
            out.set(key.toString('hex'), value.toString('hex'));
        }
    }
    return out;
}

// The same transactions through the live write path, with Y pruned for blocks
// outside the two-block window exactly as the live tracker does.
async function liveTxRecords(tmp) {
    const store = new LevelUpStore('ti-live-' + Date.now(), true);
    await store.createDatabase();
    try {
        for (const t of SEEDED_TXS) {
            await store.insertTransaction({ hash: t.txid.toString('hex'), blockHash: t.block.hash.toString('hex') });
        }
        await store.endTransaction(true);
        await store.beginTransaction();
        await store.removeTxBlockRecoveryIndexOnly(block1.hash.toString('hex'));
        await store.endTransaction(true);
        return await collectTxRecords(store.db);
    } finally {
        await store.close();
    }
}

async function seededTxRecords(dbPath) {
    const db = new ClassicLevel(dbPath, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
    await db.open();
    try { return await collectTxRecords(db); } finally { await db.close(); }
}

async function seedAndLoad(tmp, deriveOpts, loadOpts) {
    const { keysDir, stats } = await seed(tmp, deriveOpts);
    const dbPath = path.join(tmp, 'db');
    await loadKeys(Object.assign({ keysDir, dbPath }, loadOpts));
    return { keysDir, dbPath, stats };
}

async function withStore(dbPath, fn) {
    const store = new LevelUpStore('ti-read-' + Date.now(), false);
    await store.createDatabase(dbPath);
    try { return await fn(store); } finally { await store.close(); }
}

async function matchesLiveInsertTransaction(tmp) {
    const { dbPath, stats } = await seedAndLoad(tmp);
    expect(stats.T).to.equal(4);
    expect(stats.X).to.equal(4);
    expect(stats.Y).to.equal(3);
    const seeded = await seededTxRecords(dbPath);
    const live   = await liveTxRecords(tmp);
    expect(live.size).to.equal(3 + 4 + 3);
    expect(Array.from(seeded.entries()).sort()).to.deep.equal(Array.from(live.entries()).sort());
}

async function laterBlockOwnsSharedSlot(tmp) {
    const { dbPath } = await seedAndLoad(tmp);
    const db = new ClassicLevel(dbPath, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
    await db.open();
    try {
        const t = await db.get(Buffer.concat([Buffer.from([0x54]), TX_A.subarray(0, 8)]));
        expect(t.length).to.equal(64);
        expect(t.subarray(0, 32).equals(block3.hash)).to.equal(true);
        expect(t.subarray(32).equals(TX_C)).to.equal(true);
        for (const [txid, block] of [[TX_A, block1], [TX_C, block3]]) {
            const x = await db.get(Buffer.concat([Buffer.from([0x58]), txid]));
            expect(x.equals(block.hash)).to.equal(true);
        }
    } finally {
        await db.close();
    }
}

async function answersGetTxBlock(tmp) {
    const { dbPath } = await seedAndLoad(tmp);
    await withStore(dbPath, async (store) => {
        for (const t of SEEDED_TXS) {
            const res = await store.getTxBlock(t.txid.toString('hex'));
            expect(res, t.txid.toString('hex')).to.not.equal(null);
            expect(res.block_hash).to.equal(t.block.hash.toString('hex'));
            expect(res.block_height).to.equal(t.block.height);
        }
        expect(await store.getTxBlock(h32('ti-unknown').toString('hex'))).to.equal(null);
    });
}

async function rollsBackSeededTip(tmp) {
    const { dbPath } = await seedAndLoad(tmp);
    await withStore(dbPath, async (store) => {
        await store.beginTransaction();
        await store.deleteBlock(block3.hash.toString('hex'));
        await store.endTransaction(true);
        expect(await store.getTxBlock(TX_C.toString('hex'))).to.equal(null);
        expect(await store.getTxBlock(TX_D.toString('hex'))).to.equal(null);
        expect((await store.getTxBlock(TX_A.toString('hex'))).block_hash).to.equal(block1.hash.toString('hex'));
        expect((await store.getTxBlock(TX_B.toString('hex'))).block_hash).to.equal(block2.hash.toString('hex'));
    });
}

async function explicitOptOutSeedsNothing(tmp) {
    const { keysDir } = await seed(tmp, { txIndex: false });
    for (const p of ['T', 'X', 'Y']) expect(fs.existsSync(path.join(keysDir, p + '.dat')), p).to.equal(false);
    const dbPath = path.join(tmp, 'db');
    await loadKeys({ keysDir, dbPath, txIndex: false });
    expect((await seededTxRecords(dbPath)).size).to.equal(0);
}

async function survivesOutputsCleanup(tmp) {
    const { keysDir, stats } = await seed(tmp, {}, true);
    expect(stats.T).to.equal(4);
    expect(stats.X).to.equal(4);
    expect(stats.Y).to.equal(3);
    expect(fs.existsSync(path.join(keysDir, 'T.dat'))).to.equal(true);
}

async function replacesLegacyT(tmp) {
    const { dbPath } = await seedAndLoad(tmp, { removeSpent: false }, { removeSpent: false });
    const seeded = await seededTxRecords(dbPath);
    const tLens = Array.from(seeded.entries()).filter(([k]) => k.startsWith('54')).map(([, v]) => v.length / 2);
    expect(tLens).to.deep.equal([64, 64, 64]);
}

describe('Regression (bulk-sync): non-Bitcoin seeds use the live tx index (T 64B, X, Y)', function () {
    this.timeout(30000);

    let tmp;
    beforeEach(function () { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-bulk-ti-')); });
    afterEach(function () { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} });

    it('seeds T, X and Y byte-identical to the live insertTransaction path, collision included', () => matchesLiveInsertTransaction(tmp));
    it('keeps the later block in a shared T prefix slot and both txids in X', () => laterBlockOwnsSharedSlot(tmp));
    it('answers get_tx_block for seeded history', () => answersGetTxBlock(tmp));
    it('rolls back a seeded tip block without disturbing earlier seeded transactions', () => rollsBackSeededTip(tmp));
    it('survives production cleanup of the consumed outputs stream', () => survivesOutputsCleanup(tmp));
    it('supports an explicit T, X and Y opt-out', () => explicitOptOutSeedsNothing(tmp));
    it('replaces the legacy 32-byte T when removeSpent is false', () => replacesLegacyT(tmp));
});
