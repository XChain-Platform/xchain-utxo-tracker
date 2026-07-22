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

// ─── Regression: bulk-sync Z index is windowed to undoBlocks, S is not ───────
//
// Z ('Z'/0x5A, block -> first-seen script) is read only by the reorg unwind
// (removeOutputScriptsInBlock), which can never reach past the undoBlocks
// window, and the live tracker prunes Z as blocks age out of that window
// (removeOutputScriptsBlockIndexOnly). Seeded blocks below the window never
// re-enter that aging path, so an unwindowed seed would bake in one permanent
// 65-byte record per distinct script ever seen (hundreds of millions of dead
// keys on a from-genesis BTC run). derive-keys must emit Z only for scripts
// first seen in the last undoBlocks seeded blocks, while S (first-seen height,
// backing the live getFirstSeen query) stays unwindowed.

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { expect } = require('chai');

const { OutputsWriter, SpendsWriter, MetaWriter } = require('../../src/bulk-sync/writers.js');
const { externalSort } = require('../../src/bulk-sync/merger/external-sort.js');
const { leftAntiJoin } = require('../../src/bulk-sync/merger/streaming-join.js');
const { deriveKeys }   = require('../../src/bulk-sync/merger/derive-keys.js');
const { loadKeys }     = require('../../src/bulk-sync/merger/loader.js');
const { readOutputsRecordSize } = require('../../src/bulk-sync/orchestrator.js');
const { ClassicLevel } = require('classic-level');

const OUTPUTS_KEY_SIZE = 12;
const SPENDS_KEY_SIZE  = 12;
const HEADER_SIZE      = 64;
const P_SCRIPT_BLK     = 0x53; // 'S'
const P_BLK_SCRIPT     = 0x5A; // 'Z'

function fullTxid(ch) { return Buffer.from(ch.repeat(64), 'hex'); }

async function collectByPrefix(db, prefix) {
    const out = [];
    for await (const key of db.keys({ gte: Buffer.from([prefix]), lt: Buffer.from([prefix + 1]) })) {
        out.push(key.toString('hex'));
    }
    return out.sort();
}

describe('Regression (bulk-sync): Z block->script index is windowed to undoBlocks', function () {
    this.timeout(20000);

    let tmp;
    beforeEach(function () { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-bulk-zwin-')); });
    afterEach(function () { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} });

    it('emits Z only for scripts first seen in the last undoBlocks blocks; S is unwindowed', async function () {
        const nBlocks = 5, startH = 100, endH = startH + nBlocks - 1;
        const undoBlocks = 2; // window = heights 103..104

        // One DISTINCT script per block so each block is some script's
        // first-seen block (Z is keyed on first appearance, not creation).
        const blocks = [];
        for (let i = 0; i < nBlocks; i++) {
            blocks.push({
                height:    startH + i,
                blockHash: Buffer.alloc(32, 0x40 + i),
                txid:      fullTxid((0xb0 + i).toString(16)),
                script:    Buffer.alloc(32, 0x60 + i),
            });
        }

        const outputsPath = path.join(tmp, 'outputs.dat');
        const w = new OutputsWriter(outputsPath, 'bitcoin', 'regtest', startH, endH);
        for (const b of blocks) {
            w.append(b.txid.subarray(0, 8), 0, 5000000000n, b.height, b.txid, b.script, b.blockHash, false);
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
        const { stats } = await deriveKeys({
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
            // Z: only the scripts first seen in heights 103/104 get a record.
            const zKeys = await collectByPrefix(db, P_BLK_SCRIPT);
            expect(zKeys).to.have.length(undoBlocks);
            const zBlockHashes = zKeys.map(k => k.slice(2, 66)).sort();
            const expected = blocks.slice(nBlocks - undoBlocks).map(b => b.blockHash.toString('hex')).sort();
            expect(zBlockHashes).to.deep.equal(expected);

            // S: EVERY distinct script keeps its first-seen record regardless of
            // the window - S backs the live getFirstSeen query.
            const sKeys = await collectByPrefix(db, P_SCRIPT_BLK);
            expect(sKeys).to.have.length(nBlocks);

            // Stats mirror the split: Z windowed, S not.
            if (stats) {
                expect(stats.S).to.equal(nBlocks);
                expect(stats.Z).to.equal(undoBlocks);
            }
        } finally {
            await db.close();
        }
    });
});
