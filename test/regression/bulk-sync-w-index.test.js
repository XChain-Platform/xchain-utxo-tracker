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

// ─── Regression: bulk-sync W (creation-block reverse index) parity ───────────
//
// The live tracker writes a W-prefix (0x57) creation-block reverse-index record
// for every confirmed output (LevelUpDb.insertOutputBlock). It is the ONLY index
// the reorg unwind (removeCreatedOutputsInBlock) scans to purge outputs created
// in a rolled-back block but never spent. The bulk seeder is a second hand-coded
// implementation of the same layout and originally emitted no W stream, so a
// reorg into a bulk-seeded block found zero W keys and left phantom UTXOs
// (silent balance inflation).
//
// These tests drive the real pipeline end to end (writers -> external-sort ->
// anti-join -> derive-keys -> loader -> LevelDB) and prove:
//   1. Byte parity: the seeded W keyspace is byte-identical to the same outputs
//      fed through the live insertOutputBlock path (including an output spent
//      within the seeded range, which is exactly what the pre-cancellation
//      stream must still cover).
//   2. Reorg unwind: removeCreatedOutputsInBlock now finds the seeded W keys and
//      purges the O/H rows created in the rolled-back seeded block.

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { expect } = require('chai');

const { OutputsWriter, SpendsWriter, MetaWriter } = require('../../src/bulk-sync/writers.js');
const { externalSort }   = require('../../src/bulk-sync/merger/external-sort.js');
const { leftAntiJoin }   = require('../../src/bulk-sync/merger/streaming-join.js');
const { deriveKeys }     = require('../../src/bulk-sync/merger/derive-keys.js');
const { loadKeys }       = require('../../src/bulk-sync/merger/loader.js');
const { readOutputsRecordSize } = require('../../src/bulk-sync/orchestrator.js');
const LevelUpStore       = require('../../src/LevelUpDb.js');
const { ClassicLevel }   = require('classic-level');

const OUTPUTS_KEY_SIZE = 12; // txHash8(8) + vout(4)
const SPENDS_KEY_SIZE  = 12;
const HEADER_SIZE      = 64;
const P_OUT_BLK        = 0x57; // 'W'
const P_OUTPUT         = 0x4F; // 'O'

function fullTxid(ch) { return Buffer.from(ch.repeat(64), 'hex'); }

// Run the merge tail (sort -> anti-join -> derive-keys -> loader) over an
// outputs file + spends file + meta file, loading into a fresh LevelDB.
async function runMerge(tmp, outputsPath, spendsPath, metaPath, dbPath) {
    const rs = readOutputsRecordSize(outputsPath);

    const outputsSorted = path.join(tmp, 'outputs-sorted.dat');
    const spendsSorted  = path.join(tmp, 'spends-sorted.dat');
    await externalSort({ inputPath: outputsPath, outputPath: outputsSorted, headerSize: HEADER_SIZE, recordSize: rs, keySize: OUTPUTS_KEY_SIZE, ramBudgetBytes: 1 << 20, tmpDir: path.join(tmp, 'so') });
    await externalSort({ inputPath: spendsPath,  outputPath: spendsSorted,  headerSize: HEADER_SIZE, recordSize: 20, keySize: SPENDS_KEY_SIZE, ramBudgetBytes: 1 << 20, tmpDir: path.join(tmp, 'ss') });

    const liveUtxos = path.join(tmp, 'live-utxos.dat');
    await leftAntiJoin({ leftPath: outputsSorted, rightPath: spendsSorted, outputPath: liveUtxos, leftRecordSize: rs, rightRecordSize: 20, keySize: OUTPUTS_KEY_SIZE });

    const keysDir = path.join(tmp, 'keys');
    await deriveKeys({
        metaPath, outputsPath, liveUtxosPath: liveUtxos, spendsByPrevPath: spendsSorted,
        outDir: keysDir, tmpDir: path.join(tmp, 'derive'),
        ramBudgetBytes: 1 << 20, network: 'bitcoin-regtest', removeSpent: true,
        outputsRecordSize: rs,
    });

    await loadKeys({ keysDir, dbPath, removeSpent: true });
    return rs;
}

// Collect all W (creation-block reverse index) records from a DB as an array of
// "keyHex|valueHex" strings, sorted, so two keyspaces compare independent of
// iteration order.
async function collectWRecords(db) {
    const out = [];
    const gte = Buffer.from([P_OUT_BLK]);
    const lte = Buffer.from([P_OUT_BLK + 1]);
    for await (const [key, value] of db.iterator({ gte, lt: lte, keys: true, values: true })) {
        out.push(key.toString('hex') + '|' + value.toString('hex'));
    }
    return out.sort();
}

async function keyExists(db, key) {
    // classic-level resolves get() to `undefined` for a missing key (it does not
    // throw LEVEL_NOT_FOUND), so treat undefined as absent; still tolerate the
    // throwing contract of other abstract-level backends.
    try {
        const v = await db.get(key);
        return v !== undefined && v !== null;
    } catch (e) {
        if (e && (e.code === 'LEVEL_NOT_FOUND' || e.notFound)) return false;
        throw e;
    }
}

describe('Regression (bulk-sync): W creation-block index parity and reorg unwind', function () {
    this.timeout(20000);

    let tmp;
    beforeEach(function () { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-bulk-w-')); });
    afterEach(function () { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} });

    // Two blocks. block1 creates A (unspent) and S (spent in block2). block2
    // creates B (unspent) and spends S. Shared script for simplicity.
    const script    = Buffer.alloc(32, 0xab);
    const block1    = Buffer.alloc(32, 0x11);
    const block2    = Buffer.alloc(32, 0x22);
    const A = fullTxid('a'), B = fullTxid('b'), S = fullTxid('50');
    const outs = [
        { txid: A, blockHash: block1, height: 10 },
        { txid: S, blockHash: block1, height: 10 },
        { txid: B, blockHash: block2, height: 11 },
    ];

    function writeInputs() {
        const outputsPath = path.join(tmp, 'outputs.dat');
        const w = new OutputsWriter(outputsPath, 'bitcoin', 'regtest', 10, 11);
        for (const o of outs) {
            w.append(o.txid.subarray(0, 8), 0, 5000000000n, o.height, o.txid, script, o.blockHash, false);
        }
        w.close();

        const spendsPath = path.join(tmp, 'spends.dat');
        const sp = new SpendsWriter(spendsPath, 'bitcoin', 'regtest', 10, 11);
        sp.append(S.subarray(0, 8), 0, B.subarray(0, 8)); // block2 spends S:0
        sp.close();

        const metaPath = path.join(tmp, 'meta.dat');
        const meta = new MetaWriter(metaPath, 'bitcoin', 'regtest', 10, 11);
        meta.writeBlock(10, 1700000000, block1, Buffer.alloc(32), [A.subarray(0, 8), S.subarray(0, 8)]);
        meta.writeBlock(11, 1700000600, block2, block1, [B.subarray(0, 8)]);
        meta.close();

        return { outputsPath, spendsPath, metaPath };
    }

    // Build the same W keyspace through the LIVE insertOutputBlock path (one
    // record per created output, including the spent-in-range S:0).
    async function buildLiveW() {
        const store = new LevelUpStore('bulk-w-live-' + Date.now() + '-' + Math.random(), true);
        await store.createDatabase();
        await store.beginTransaction();
        for (const o of outs) {
            await store.insertOutputBlock({
                scriptPubKey: script,
                txHash:       o.txid.subarray(0, 8).toString('hex'),
                outputIndex:  0,
                blockHash:    o.blockHash.toString('hex'),
            });
        }
        await store.endTransaction();
        return store;
    }

    it('seeded W keyspace is byte-identical to the live insertOutputBlock path', async function () {
        const { outputsPath, spendsPath, metaPath } = writeInputs();
        const dbPath = path.join(tmp, 'db');
        await runMerge(tmp, outputsPath, spendsPath, metaPath, dbPath);

        const seededDb = new ClassicLevel(dbPath, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
        await seededDb.open();
        const liveStore = await buildLiveW();
        try {
            const seededW = await collectWRecords(seededDb);
            const liveW   = await collectWRecords(liveStore.db);

            // Three created outputs -> three W records, including the spent S:0.
            expect(seededW).to.have.length(3);
            expect(seededW).to.deep.equal(liveW);
        } finally {
            await seededDb.close();
            await liveStore.db.close();
        }
    });

    it('removeCreatedOutputsInBlock finds seeded W keys and purges rolled-back O/H', async function () {
        const { outputsPath, spendsPath, metaPath } = writeInputs();
        const dbPath = path.join(tmp, 'db');
        await runMerge(tmp, outputsPath, spendsPath, metaPath, dbPath);

        const store = new LevelUpStore('bulk-w-reorg', false);
        store.db = new ClassicLevel(dbPath, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
        await store.db.open();
        try {
            // A:0 was created in block1 and is unspent -> O record present.
            const oKeyA = Buffer.concat([Buffer.from([P_OUTPUT]), script, A.subarray(0, 8), Buffer.alloc(4)]);
            expect(await keyExists(store.db, oKeyA)).to.equal(true);
            // W keys for block1 present (A:0 and S:0).
            expect(await collectWRecords(store.db)).to.have.length(3);

            // Roll back block1.
            await store.beginTransaction();
            await store.removeCreatedOutputsInBlock(block1.toString('hex'));
            await store.endTransaction();

            // A:0's O record is gone (the phantom-UTXO path is closed).
            expect(await keyExists(store.db, oKeyA)).to.equal(false);
            // Only block2's single W record (B:0) survives.
            const remaining = await collectWRecords(store.db);
            expect(remaining).to.have.length(1);
            expect(remaining[0].slice(2, 66)).to.equal(block2.toString('hex'));
        } finally {
            await store.db.close();
        }
    });
});

describe('Regression (bulk-sync): W index is windowed to undoBlocks', function () {
    this.timeout(20000);

    let tmp;
    beforeEach(function () { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-bulk-wwin-')); });
    afterEach(function () { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} });

    // The reorg unwind can never reach past the undoBlocks window and the live
    // tracker prunes W as blocks age out of it (TP-19), but seeded blocks below
    // the window never re-enter that aging path. An unwindowed seed therefore
    // leaves one PERMANENT 77-byte record per output ever created (~hundreds of
    // GB on a from-genesis BTC mainnet run). derive-keys must emit W only for
    // outputs created in the last undoBlocks seeded blocks.
    it('emits W only for outputs created in the last undoBlocks seeded blocks', async function () {
        const script = Buffer.alloc(32, 0xcd);
        const nBlocks = 5, startH = 100, endH = startH + nBlocks - 1;
        const undoBlocks = 2;

        const blocks = [];
        for (let i = 0; i < nBlocks; i++) {
            blocks.push({
                height:    startH + i,
                blockHash: Buffer.alloc(32, 0x30 + i),
                txid:      fullTxid((0xa0 + i).toString(16)),
            });
        }

        const outputsPath = path.join(tmp, 'outputs.dat');
        const w = new OutputsWriter(outputsPath, 'bitcoin', 'regtest', startH, endH);
        for (const b of blocks) {
            w.append(b.txid.subarray(0, 8), 0, 5000000000n, b.height, b.txid, script, b.blockHash, false);
        }
        w.close();

        const spendsPath = path.join(tmp, 'spends.dat');
        new SpendsWriter(spendsPath, 'bitcoin', 'regtest', startH, endH).close();

        const metaPath = path.join(tmp, 'meta.dat');
        const meta = new MetaWriter(metaPath, 'bitcoin', 'regtest', startH, endH);
        let prev = Buffer.alloc(32);
        for (const b of blocks) {
            meta.writeBlock(b.height, 1700000000 + b.height, b.blockHash, prev, [b.txid.subarray(0, 8)]);
            prev = b.blockHash;
        }
        meta.close();

        const rs = readOutputsRecordSize(outputsPath);
        const outputsSorted = path.join(tmp, 'outputs-sorted.dat');
        const spendsSorted  = path.join(tmp, 'spends-sorted.dat');
        await externalSort({ inputPath: outputsPath, outputPath: outputsSorted, headerSize: HEADER_SIZE, recordSize: rs, keySize: OUTPUTS_KEY_SIZE, ramBudgetBytes: 1 << 20, tmpDir: path.join(tmp, 'so') });
        await externalSort({ inputPath: spendsPath,  outputPath: spendsSorted,  headerSize: HEADER_SIZE, recordSize: 20, keySize: SPENDS_KEY_SIZE, ramBudgetBytes: 1 << 20, tmpDir: path.join(tmp, 'ss') });
        const liveUtxos = path.join(tmp, 'live-utxos.dat');
        await leftAntiJoin({ leftPath: outputsSorted, rightPath: spendsSorted, outputPath: liveUtxos, leftRecordSize: rs, rightRecordSize: 20, keySize: OUTPUTS_KEY_SIZE });

        const keysDir = path.join(tmp, 'keys');
        await deriveKeys({
            metaPath, outputsPath, liveUtxosPath: liveUtxos, spendsByPrevPath: spendsSorted,
            outDir: keysDir, tmpDir: path.join(tmp, 'derive'),
            ramBudgetBytes: 1 << 20, network: 'bitcoin-regtest', removeSpent: true,
            outputsRecordSize: rs, undoBlocks,
        });

        const dbPath = path.join(tmp, 'db');
        await loadKeys({ keysDir, dbPath, removeSpent: true });

        const db = new ClassicLevel(dbPath, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
        await db.open();
        try {
            const seededW = await collectWRecords(db);
            // Only the last undoBlocks blocks (heights 103, 104) get W records.
            expect(seededW).to.have.length(undoBlocks);
            const wBlockHashes = seededW.map(r => r.slice(2, 66)).sort();
            const expected = blocks.slice(nBlocks - undoBlocks).map(b => b.blockHash.toString('hex')).sort();
            expect(wBlockHashes).to.deep.equal(expected);

            // Every O record survives regardless of the W window: windowing W
            // must not touch the live-UTXO set itself.
            let oCount = 0;
            for await (const k of db.keys({ gte: Buffer.from([P_OUTPUT]), lt: Buffer.from([P_OUTPUT + 1]) })) oCount++;
            expect(oCount).to.equal(nBlocks);
        } finally {
            await db.close();
        }
    });
});
