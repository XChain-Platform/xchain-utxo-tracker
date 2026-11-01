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

// Two transactions whose txids share their first 8 bytes, through the whole
// bulk-sync pipeline (processBlock -> writers -> sort -> anti-join -> derive ->
// loader). The anti-join and every seeded key must be on the whole txid: on an
// 8-byte join a spend of one transaction's output cancels the other's, and the
// two transactions' O/H/W records land on the same keys.

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const crypto = require('crypto');
const { expect } = require('chai');

const { processBlock } = require('../../../src/bulk_sync/process_block.js');
const { OutputsWriter, SpendsWriter, MetaWriter, OUTPUTS_RECORD_SIZE, SPENDS_RECORD_SIZE, HEADER_SIZE } = require('../../../src/bulk_sync/writers.js');
const { OUTPUTS_KEY_SIZE, SPENDS_KEY_SIZE } = require('../../../src/bulk_sync/orchestrator/constants.js');
const { externalSort } = require('../../../src/bulk_sync/merger/external_sort.js');
const { leftAntiJoin } = require('../../../src/bulk_sync/merger/streaming_join.js');
const { deriveKeys }   = require('../../../src/bulk_sync/merger/derive_keys.js');
const { loadKeys }     = require('../../../src/bulk_sync/merger/loader.js');
const { resumeArgsForWorkDir } = require('../../../src/bulk_sync/orchestrator/file_ops.js');
const LevelUpStore     = require('../../../src/store/level_up_db.js');
const { STORE_LAYOUT_VERSION } = require('../../../src/store/level_up_db/constants.js');

const h32 = (label) => crypto.createHash('sha256').update(label).digest();
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// A transaction as processBlock reads it: getHash() is the internal (reversed)
// byte order of the display txid.
function fakeTx(displayTxid, ins, outs) {
    const internal = Buffer.from(displayTxid, 'hex').reverse();
    return { getHash: () => internal, getId: () => displayTxid, ins, outs };
}
const spendOf = (displayTxid, index) => ({ hash: Buffer.from(displayTxid, 'hex').reverse(), index, script: Buffer.alloc(0) });

const PREFIX = 'c0ffee00c0ffee00';
const A = PREFIX + h32('collide-a').toString('hex').slice(16);
const B = PREFIX + h32('collide-b').toString('hex').slice(16);
const C = h32('collide-c').toString('hex');
const scriptA = Buffer.from('0014' + 'aa'.repeat(20), 'hex');
const scriptB = Buffer.from('0014' + 'bb'.repeat(20), 'hex');
const scriptC = Buffer.from('0014' + 'cc'.repeat(20), 'hex');
const block1 = h32('collide-block-1');
const block2 = h32('collide-block-2');

// Block 10 creates A:0 and B:0 (A and B share their first 8 txid bytes), in the
// given order; block 11 spends A:0 only. Both funding inputs spend outpoints
// from below the range. The order matters on an 8-byte join: the two outputs
// tie on the join key and the spend cancels whichever sorts first.
function writeStreams(tmp, order) {
    const paths = { outputs: path.join(tmp, 'outputs.dat'), spends: path.join(tmp, 'spends.dat'), meta: path.join(tmp, 'meta.dat') };
    const writers = {
        outputs: new OutputsWriter(paths.outputs, 'bitcoin', 'regtest', 10, 11),
        spends:  new SpendsWriter(paths.spends, 'bitcoin', 'regtest', 10, 11),
        meta:    new MetaWriter(paths.meta, 'bitcoin', 'regtest', 10, 11),
    };
    const txA = fakeTx(A, [spendOf(h32('below-1').toString('hex'), 0)], [{ script: scriptA, value: 1000 }]);
    const txB = fakeTx(B, [spendOf(h32('below-2').toString('hex'), 0)], [{ script: scriptB, value: 2000 }]);
    processBlock({ prevHash: Buffer.alloc(32), timestamp: 1700000000,
        transactions: order === 'ab' ? [txA, txB] : [txB, txA] }, 10, block1, writers);
    processBlock({ prevHash: Buffer.from(block1).reverse(), timestamp: 1700000600, transactions: [
        fakeTx(C, [spendOf(A, 0)], [{ script: scriptC, value: 900 }]),
    ] }, 11, block2, writers);
    for (const w of Object.values(writers)) w.close();
    return paths;
}

async function seed(tmp, order, dbPath = path.join(tmp, 'db')) {
    const p = writeStreams(tmp, order);
    const outputsSorted = path.join(tmp, 'outputs-sorted.dat');
    const spendsSorted  = path.join(tmp, 'spends-sorted.dat');
    await externalSort({ inputPath: p.outputs, outputPath: outputsSorted, headerSize: HEADER_SIZE, recordSize: OUTPUTS_RECORD_SIZE, keySize: OUTPUTS_KEY_SIZE, ramBudgetBytes: 1 << 20, tmpDir: path.join(tmp, 'so') });
    await externalSort({ inputPath: p.spends, outputPath: spendsSorted, headerSize: HEADER_SIZE, recordSize: SPENDS_RECORD_SIZE, keySize: SPENDS_KEY_SIZE, ramBudgetBytes: 1 << 20, tmpDir: path.join(tmp, 'ss') });
    const liveUtxos = path.join(tmp, 'live-utxos.dat');
    const join = await leftAntiJoin({ leftPath: outputsSorted, rightPath: spendsSorted, outputPath: liveUtxos, leftRecordSize: OUTPUTS_RECORD_SIZE, rightRecordSize: SPENDS_RECORD_SIZE, keySize: OUTPUTS_KEY_SIZE });
    const keysDir = path.join(tmp, 'keys');
    await deriveKeys({
        metaPath: p.meta, outputsPath: p.outputs, liveUtxosPath: liveUtxos, spendsByPrevPath: spendsSorted,
        outDir: keysDir, tmpDir: path.join(tmp, 'derive'), ramBudgetBytes: 1 << 20,
        network: 'bitcoin-regtest', outputsRecordSize: OUTPUTS_RECORD_SIZE,
    });
    await loadKeys({ keysDir, dbPath });
    return { dbPath, join };
}

describe('Regression (bulk-sync): txids sharing their first 8 bytes', function () {
    this.timeout(20000);

    let tmp;
    beforeEach(function () { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-bulk-collide-')); });
    afterEach(function () { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* gone */ } });

    for (const order of ['ab', 'ba']) {
        it(`seeds the unspent output of one and drops the spent output of the other (block order ${order})`, async function () {
            expect(A.slice(0, 16)).to.equal(B.slice(0, 16));
            const { dbPath, join } = await seed(tmp, order);
            expect(join.canceled, 'the spend of A:0 cancels exactly one output').to.equal(1);

            const store = new LevelUpStore('bulk-collide-' + Date.now(), false);
            await store.createDatabase(dbPath);
            try {
                const a = await store.getOutputsScriptPubKey(sha(scriptA));
                const b = await store.getOutputsScriptPubKey(sha(scriptB));
                const c = await store.getOutputsScriptPubKey(sha(scriptC));
                expect(a.map((o) => o.fullTxid), 'the spent A:0 is still seeded').to.deep.equal([]);
                expect(b.map((o) => o.fullTxid), 'B:0 was cancelled by the spend of A:0').to.deep.equal([B]);
                expect(c.map((o) => o.fullTxid)).to.deep.equal([C]);
            } finally {
                await store.close();
            }
        });
    }

});

describe('Regression (bulk-sync): the layout stamp and the bulk load', function () {
    this.timeout(20000);

    let tmp;
    beforeEach(function () { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-bulk-stamp-')); });
    afterEach(function () { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* gone */ } });

    // A tracker's start() stamps an empty store with the current layout. Stopped
    // before its first flush, it leaves a store whose only key is that stamp; the
    // next boot reads it as empty (no tip) and takes the bulk path, so the loader
    // must accept it or every later boot refuses the load the same way.
    it('seeds a store whose only key is the layout stamp a stopped tracker left', async function () {
        const dbPath = path.join(tmp, 'db-stamped');
        const stopped = new LevelUpStore('bulk-collide-stopped-' + Date.now(), false);
        await stopped.createDatabase(dbPath);
        expect(await stopped.ensureLayoutVersion()).to.equal('empty');
        await stopped.close();

        const boot = new LevelUpStore('bulk-collide-boot-' + Date.now(), false);
        await boot.createDatabase(dbPath);
        expect(await boot.ensureLayoutVersion({ stamp: false })).to.equal('current');
        expect(await boot.getLastBlockHeight(), 'api.js isDbEmpty reads this store as empty').to.equal(-1);
        await boot.close();

        await seed(tmp, 'ab', dbPath);
        const store = new LevelUpStore('bulk-collide-seeded-' + Date.now(), false);
        await store.createDatabase(dbPath);
        try {
            expect(await store.getLastBlockHeight()).to.equal(11);
            expect(await store.getLayoutVersion()).to.equal(STORE_LAYOUT_VERSION);
            expect((await store.getOutputsScriptPubKey(sha(scriptB))).map((o) => o.fullTxid)).to.deep.equal([B]);
        } finally {
            await store.close();
        }
    });

    it('stamps the seeded store with the current layout in the same batch as its tip', async function () {
        const { dbPath } = await seed(tmp, 'ab');
        const store = new LevelUpStore('bulk-collide-stamp-' + Date.now(), false);
        await store.createDatabase(dbPath);
        try {
            expect(await store.getLayoutVersion()).to.equal(STORE_LAYOUT_VERSION);
            expect(await store.getLastBlockHeight()).to.equal(11);
            expect(await store.ensureLayoutVersion()).to.equal('current');
        } finally {
            await store.close();
        }
    });
});

describe('Regression (bulk-sync): resuming a work dir across the txid format change', function () {
    let tmp;
    beforeEach(function () { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-bulk-resume-fmt-')); });
    afterEach(function () { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* gone */ } });

    function workDirWith(magic) {
        const work = path.join(tmp, 'work');
        fs.mkdirSync(path.join(work, 'parsed'), { recursive: true });
        const header = Buffer.alloc(HEADER_SIZE);
        Buffer.from(magic, 'ascii').copy(header, 0);
        fs.writeFileSync(path.join(work, 'parsed', 'outputs-w00.dat'), header);
        return work;
    }

    it('resumes current-format parse output with --skip-parse', function () {
        const work = workDirWith('XCHNOUT2');
        const lines = [];
        expect(resumeArgsForWorkDir(work, (l) => lines.push(l))).to.deep.equal(['--skip-parse']);
        expect(fs.existsSync(work)).to.equal(true);
    });

    it('clears a work dir whose parse output is from the older format and starts over', function () {
        const work = workDirWith('XCHNOUT1');
        const lines = [];
        expect(resumeArgsForWorkDir(work, (l) => lines.push(l))).to.deep.equal([]);
        expect(fs.existsSync(work)).to.equal(false);
        expect(lines.join('\n')).to.match(/older bulk-sync format; clearing/);
    });

    it('does nothing for a work dir with no parse output', function () {
        expect(resumeArgsForWorkDir(path.join(tmp, 'absent'), () => {})).to.deep.equal([]);
    });
});
