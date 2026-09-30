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

// Regression: the bulk seeder builds only the live-parity prefix set by default.
//
// The live confirmed path never writes I or J, so a seed carrying them (the old
// removeSpent=false default of deriveKeys/loadKeys, or --no-remove-spent) is a
// store the live tracker cannot produce. These tests pin the per-mode prefix set,
// the orchestrator's refusal of --no-remove-spent, and that the standalone
// run_loader.js loads a default seed instead of failing on a missing I.dat.

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { expect } = require('chai');
const { ClassicLevel } = require('classic-level');

const { OutputsWriter, SpendsWriter, MetaWriter } = require('../../../src/bulk_sync/writers.js');
const { externalSort }   = require('../../../src/bulk_sync/merger/external_sort.js');
const { leftAntiJoin }   = require('../../../src/bulk_sync/merger/streaming_join.js');
const { deriveKeys }     = require('../../../src/bulk_sync/merger/derive_keys.js');
const { loadKeys }       = require('../../../src/bulk_sync/merger/loader.js');
const { parseArgs, readOutputsRecordSize } = require('../../../src/bulk_sync/orchestrator.js');

const OUTPUTS_KEY_SIZE = 12;
const SPENDS_KEY_SIZE  = 12;
const HEADER_SIZE      = 64;
const RUN_LOADER       = path.join(__dirname, '../../../src/bulk_sync/run_loader.js');

function h32(label) { return crypto.createHash('sha256').update(label).digest(); }

const block1 = { height: 10, ts: 1700000000, hash: h32('rs-block-1'), prev: h32('rs-block-0') };
const block2 = { height: 11, ts: 1700000600, hash: h32('rs-block-2'), prev: block1.hash };
const TX_A   = h32('rs-tx-a');
const TX_B   = h32('rs-tx-b');

// Two blocks: TX_A creates two outputs in block 1, TX_B spends one of them in block 2.
function writeInputs(tmp) {
    const outputsPath = path.join(tmp, 'outputs.dat');
    const w = new OutputsWriter(outputsPath, 'bitcoin', 'regtest', block1.height, block2.height);
    w.append(TX_A.subarray(0, 8), 0, 1000n, block1.height, TX_A, h32('rs-script-1'), block1.hash, false);
    w.append(TX_A.subarray(0, 8), 1, 2000n, block1.height, TX_A, h32('rs-script-2'), block1.hash, false);
    w.append(TX_B.subarray(0, 8), 0, 900n,  block2.height, TX_B, h32('rs-script-3'), block2.hash, false);
    w.close();

    const spendsPath = path.join(tmp, 'spends.dat');
    const sp = new SpendsWriter(spendsPath, 'bitcoin', 'regtest', block1.height, block2.height);
    sp.append(TX_A.subarray(0, 8), 1, TX_B.subarray(0, 8));
    sp.close();

    const metaPath = path.join(tmp, 'meta.dat');
    const meta = new MetaWriter(metaPath, 'bitcoin', 'regtest', block1.height, block2.height);
    meta.writeBlock(block1.height, block1.ts, block1.hash, block1.prev, [TX_A.subarray(0, 8)]);
    meta.writeBlock(block2.height, block2.ts, block2.hash, block2.prev, [TX_B.subarray(0, 8)]);
    meta.close();
    return { outputsPath, spendsPath, metaPath };
}

// Sort and anti-join the fixture, then derive keys; removeSpent is passed only when given.
async function derive(tmp, removeSpentOpt) {
    const { outputsPath, spendsPath, metaPath } = writeInputs(tmp);
    const rs = readOutputsRecordSize(outputsPath);
    const outputsSorted = path.join(tmp, 'outputs-sorted.dat');
    const spendsSorted  = path.join(tmp, 'spends-sorted.dat');
    await externalSort({ inputPath: outputsPath, outputPath: outputsSorted, headerSize: HEADER_SIZE, recordSize: rs, keySize: OUTPUTS_KEY_SIZE, ramBudgetBytes: 1 << 20, tmpDir: path.join(tmp, 'so') });
    await externalSort({ inputPath: spendsPath,  outputPath: spendsSorted,  headerSize: HEADER_SIZE, recordSize: 20, keySize: SPENDS_KEY_SIZE, ramBudgetBytes: 1 << 20, tmpDir: path.join(tmp, 'ss') });
    const liveUtxos = path.join(tmp, 'live-utxos.dat');
    await leftAntiJoin({ leftPath: outputsSorted, rightPath: spendsSorted, outputPath: liveUtxos, leftRecordSize: rs, rightRecordSize: 20, keySize: OUTPUTS_KEY_SIZE });

    const keysDir = path.join(tmp, 'keys');
    const opts = {
        metaPath, outputsPath, liveUtxosPath: liveUtxos, spendsByPrevPath: spendsSorted,
        outDir: keysDir, tmpDir: path.join(tmp, 'derive'),
        ramBudgetBytes: 1 << 20, network: 'bitcoin-regtest', undoBlocks: 100, outputsRecordSize: rs,
    };
    if (removeSpentOpt !== undefined) opts.removeSpent = removeSpentOpt;
    const { stats } = await deriveKeys(opts);
    return { keysDir, stats };
}

// Count the loaded records per first key byte (single-letter prefixes only).
async function prefixCounts(dbPath) {
    const db = new ClassicLevel(dbPath, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
    await db.open();
    const counts = {};
    try {
        for await (const [key] of db.iterator({ keys: true, values: false })) {
            const p = String.fromCharCode(key[0]);
            counts[p] = (counts[p] || 0) + 1;
        }
    } finally {
        await db.close();
    }
    return counts;
}

describe('Regression (bulk-sync): removeSpent defaults to the live-parity prefix set', function () {
    this.timeout(20000);

    let tmp;
    beforeEach(function () { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-bulk-rs-')); });
    afterEach(function () { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} });

    it('derives and loads no T/I/J when removeSpent is omitted', async function () {
        const { keysDir } = await derive(tmp, undefined);
        for (const p of ['T', 'I', 'J']) {
            expect(fs.existsSync(path.join(keysDir, p + '.dat')), p + '.dat').to.equal(false);
        }
        const dbPath = path.join(tmp, 'db');
        await loadKeys({ keysDir, dbPath });
        const counts = await prefixCounts(dbPath);
        for (const p of ['T', 'I', 'J']) expect(counts[p], p).to.equal(undefined);
        expect(counts.B).to.equal(2);
        expect(counts.O).to.equal(2);
    });

    it('emits and loads T/I/J only on an explicit removeSpent:false, one I and one J per spend', async function () {
        const { keysDir, stats } = await derive(tmp, false);
        expect(stats.I).to.equal(1);
        expect(stats.J).to.equal(1);
        const dbPath = path.join(tmp, 'db');
        await loadKeys({ keysDir, dbPath, removeSpent: false });
        const counts = await prefixCounts(dbPath);
        expect(counts.T).to.equal(2);
        expect(counts.I).to.equal(1);
        expect(counts.J).to.equal(1);
    });

    it('orchestrator parseArgs rejects --no-remove-spent and keeps --remove-spent', function () {
        const base = ['node', 'orchestrator.js', '--network', 'bitcoin-regtest', '--out', '/tmp/o', '--db', '/tmp/d'];
        expect(() => parseArgs(base.concat('--no-remove-spent'))).to.throw(/--no-remove-spent is not supported/);
        expect(parseArgs(base.concat('--remove-spent')).removeSpent).to.equal(true);
        expect(parseArgs(base).removeSpent).to.equal(true);
    });

    it('run_loader.js loads an orchestrator (removeSpent:true) seed into a fresh DB with no T/I/J', async function () {
        const { keysDir } = await derive(tmp, true);
        const dbPath = path.join(tmp, 'db-cli');
        const res = spawnSync(process.execPath, [RUN_LOADER, '--keys', keysDir, '--out', dbPath], { encoding: 'utf8' });
        expect(res.status, res.stderr).to.equal(0);
        const counts = await prefixCounts(dbPath);
        for (const p of ['T', 'I', 'J']) expect(counts[p], p).to.equal(undefined);
        expect(counts.B).to.equal(2);
    });
});
