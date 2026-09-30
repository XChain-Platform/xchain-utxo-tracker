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

// Regression: bulk-sync record layout parity with the live store, every prefix.
//
// The bulk seeder writes each prefix's key and value bytes by hand at fixed
// offsets (derive_keys_pass*.js) and slices them back by the widths in
// record_layout.js LAYOUT. The live tracker builds the same records through
// key_codec.js and value_codec.js. A one-sided edit to a prefix byte, a width
// or a field offset would make a seeded DB carry keys the live store never
// reads (lost UTXOs, missed hints) with nothing failing until a full
// validate_db walk. These tests tie the two sides together:
//   1. Layout: every LAYOUT row matches the live builder and encoder widths,
//      and the bulk prefix bytes are the live store's own constants.
//   2. Pipeline: a small chain driven through the real merge tail with
//      removeSpent:false (so all ten prefixes are written) seeds exactly the
//      (key, value) pairs the live builders and encoders produce for it.

const crypto = require('crypto');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { expect } = require('chai');
const { ClassicLevel } = require('classic-level');

const { OutputsWriter, SpendsWriter, MetaWriter } = require('../../../src/bulk_sync/writers.js');
const { externalSort }   = require('../../../src/bulk_sync/merger/external_sort.js');
const { leftAntiJoin }   = require('../../../src/bulk_sync/merger/streaming_join.js');
const { deriveKeys, LAYOUT } = require('../../../src/bulk_sync/merger/derive_keys.js');
const { loadKeys }       = require('../../../src/bulk_sync/merger/loader.js');
const { readOutputsRecordSize } = require('../../../src/bulk_sync/orchestrator.js');
const bulkLayout         = require('../../../src/bulk_sync/merger/derive_keys/record_layout.js');
const liveConstants      = require('../../../src/store/level_up_db/constants.js');
const {
    kBlock, kTx, kInput, kOutputFromBuf, kOutHint, kInHint,
    kStoredBlk, kScriptBlkFromBuf, kOutBlk, kBlkScriptFromBuf,
} = require('../../../src/store/level_up_db/key_codec.js');
const {
    encodeBlock, encodeTx, encodeInputVal, encodeOutput, encodeOutHint, encodeScriptBlk,
} = require('../../../src/store/level_up_db/value_codec.js');

const OUTPUTS_KEY_SIZE = 12; // txHash8(8) + vout(4)
const SPENDS_KEY_SIZE  = 12;
const HEADER_SIZE      = 64;
const EMPTY            = Buffer.alloc(0);

// The ten prefixes the seeder writes, keyed by LAYOUT letter.
const PREFIX_NAMES = {
    B: 'P_BLOCK', T: 'P_TX', I: 'P_INPUT', O: 'P_OUTPUT', H: 'P_OUT_HINT',
    J: 'P_IN_HINT', N: 'P_STORED_BLK', S: 'P_SCRIPT_BLK', W: 'P_OUT_BLK', Z: 'P_BLK_SCRIPT',
};

// Hash a label to 32 distinct bytes, so a shifted or swapped field never lines
// up with its neighbour by accident the way a repeated fill byte would.
function h32(label) { return crypto.createHash('sha256').update(label).digest(); }
function hex8(buf)  { return buf.subarray(0, 8).toString('hex'); }

// One live sample per prefix: the key the live builder makes and the value the
// live write path stores. T is the 32-byte blockHash that live decodeTx reads;
// the live writer's appended full txid and its exact-txid index are not seeded
// by bulk sync (README, Upgrading).
function liveSample(p) {
    const hash = h32('sample-hash').toString('hex');
    const tx8  = hex8(h32('sample-tx'));
    const scr  = h32('sample-script');
    switch (p) {
    case 'B': return { key: kBlock(hash),                 val: encodeBlock(1, 2, hash) };
    case 'T': return { key: kTx(tx8),                     val: encodeTx(hash) };
    case 'I': return { key: kInput(tx8, 3),               val: encodeInputVal(tx8) };
    // The O intermediate keeps the coinbase byte, so its width is the coinbase form.
    case 'O': return { key: kOutputFromBuf(scr, tx8, 3),  val: encodeOutput(5n, 1, hash, true) };
    case 'H': return { key: kOutHint(tx8, 3),             val: encodeOutHint(scr.toString('hex')) };
    case 'J': return { key: kInHint(tx8, tx8, 3),         val: EMPTY };
    case 'N': return { key: kStoredBlk(hash),             val: EMPTY };
    case 'S': return { key: kScriptBlkFromBuf(scr),       val: encodeScriptBlk(1) };
    case 'W': return { key: kOutBlk(hash, tx8, 3),        val: scr };
    case 'Z': return { key: kBlkScriptFromBuf(hash, scr), val: EMPTY };
    default:  return null;
    }
}

describe('Regression (bulk-sync): record layout parity with the live store', function () {
    it('LAYOUT names exactly the ten seeded prefixes', function () {
        expect(Object.keys(LAYOUT).sort()).to.deep.equal(Object.keys(PREFIX_NAMES).sort());
    });

    it('bulk prefix bytes are the live store constants', function () {
        for (const [p, name] of Object.entries(PREFIX_NAMES)) {
            expect(bulkLayout[name], name).to.be.a('number');
            expect(bulkLayout[name], name).to.equal(liveConstants[name]);
            expect(liveConstants[name], name).to.equal(p.charCodeAt(0));
        }
    });

    it('every LAYOUT width matches the live key builder and value encoder', function () {
        for (const p of Object.keys(LAYOUT)) {
            const sample = liveSample(p);
            expect(sample, `no live sample for prefix ${p}`).to.not.equal(null);
            const { keySize, valSize, recordSize } = LAYOUT[p];
            expect(sample.key[0], `${p} prefix byte`).to.equal(bulkLayout[PREFIX_NAMES[p]]);
            expect(keySize, `${p} keySize`).to.equal(sample.key.length);
            expect(valSize, `${p} valSize`).to.equal(sample.val.length);
            expect(recordSize, `${p} recordSize`).to.equal(keySize + valSize);
        }
    });
});

// Fixture chain: two blocks, one coinbase, a spend inside the range, a script
// reused across blocks, and non-zero vouts so a vout field swap shows.
const block1 = { height: 10, ts: 1700000000, hash: h32('block-1'), prev: h32('block-0') };
const block2 = { height: 11, ts: 1700000600, hash: h32('block-2'), prev: block1.hash };
const scriptX = h32('script-x');
const scriptY = h32('script-y');
const scriptZ = h32('script-z');
const OUTS = [
    { name: 'cb', txid: h32('tx-cb'), vout: 0, value: 5000000000n, block: block1, script: scriptX, coinbase: true },
    { name: 'a',  txid: h32('tx-a'),  vout: 1, value: 1234n,       block: block1, script: scriptY, coinbase: false },
    { name: 's',  txid: h32('tx-s'),  vout: 2, value: 777n,        block: block1, script: scriptX, coinbase: false },
    { name: 'b',  txid: h32('tx-b'),  vout: 3, value: 999n,        block: block2, script: scriptZ, coinbase: false },
    { name: 'b2', txid: h32('tx-b'),  vout: 4, value: 888n,        block: block2, script: scriptX, coinbase: false },
];
const SPENT = OUTS.find(o => o.name === 's');
const SPENDER = h32('tx-b');

function writeInputs(tmp) {
    const outputsPath = path.join(tmp, 'outputs.dat');
    const w = new OutputsWriter(outputsPath, 'bitcoin', 'regtest', block1.height, block2.height);
    for (const o of OUTS) {
        w.append(o.txid.subarray(0, 8), o.vout, o.value, o.block.height, o.txid, o.script, o.block.hash, o.coinbase);
    }
    w.close();

    const spendsPath = path.join(tmp, 'spends.dat');
    const sp = new SpendsWriter(spendsPath, 'bitcoin', 'regtest', block1.height, block2.height);
    sp.append(SPENT.txid.subarray(0, 8), SPENT.vout, SPENDER.subarray(0, 8));
    sp.close();

    const metaPath = path.join(tmp, 'meta.dat');
    const meta = new MetaWriter(metaPath, 'bitcoin', 'regtest', block1.height, block2.height);
    meta.writeBlock(block1.height, block1.ts, block1.hash, block1.prev,
        [h32('tx-cb'), h32('tx-a'), h32('tx-s')].map(t => t.subarray(0, 8)));
    meta.writeBlock(block2.height, block2.ts, block2.hash, block2.prev, [SPENDER.subarray(0, 8)]);
    meta.close();

    return { outputsPath, spendsPath, metaPath };
}

// Run writers -> external sort -> anti-join -> derive-keys -> loader, keeping
// T/I/J (removeSpent:false) and a window wide enough to hold both blocks.
async function runMerge(tmp, dbPath) {
    const { outputsPath, spendsPath, metaPath } = writeInputs(tmp);
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
        ramBudgetBytes: 1 << 20, network: 'bitcoin-regtest', undoBlocks: 100, removeSpent: false,
        outputsRecordSize: rs,
    });
    await loadKeys({ keysDir, dbPath, removeSpent: false });
}

// The records the live builders and encoders produce for the fixture chain,
// per prefix, as sorted "keyHex|valueHex" strings.
function expectedRecords() {
    const rec = {};
    const add = (p, key, val) => { (rec[p] = rec[p] || []).push(key.toString('hex') + '|' + val.toString('hex')); };
    const unspent = OUTS.filter(o => o !== SPENT);

    for (const b of [block1, block2]) {
        add('B', kBlock(b.hash.toString('hex')), encodeBlock(b.height, b.ts, b.prev.toString('hex')));
        add('N', kStoredBlk(b.hash.toString('hex')), EMPTY);
    }
    for (const [txid, b] of [[h32('tx-cb'), block1], [h32('tx-a'), block1], [h32('tx-s'), block1], [SPENDER, block2]]) {
        add('T', kTx(hex8(txid)), encodeTx(b.hash.toString('hex')));
    }
    for (const o of unspent) {
        add('O', kOutputFromBuf(o.script, hex8(o.txid), o.vout),
            encodeOutput(o.value, o.block.height, o.txid.toString('hex'), o.coinbase));
        add('H', kOutHint(hex8(o.txid), o.vout), encodeOutHint(o.script.toString('hex')));
    }
    add('I', kInput(hex8(SPENT.txid), SPENT.vout), encodeInputVal(hex8(SPENDER)));
    add('J', kInHint(hex8(SPENDER), hex8(SPENT.txid), SPENT.vout), EMPTY);
    for (const o of OUTS) {
        add('W', kOutBlk(o.block.hash.toString('hex'), hex8(o.txid), o.vout), o.script);
    }
    // S and Z carry each script's first-seen block only.
    const firstSeen = new Map();
    for (const o of OUTS) {
        const k = o.script.toString('hex');
        if (!firstSeen.has(k)) firstSeen.set(k, o);
    }
    for (const o of firstSeen.values()) {
        add('S', kScriptBlkFromBuf(o.script), encodeScriptBlk(o.block.height));
        add('Z', kBlkScriptFromBuf(o.block.hash.toString('hex'), o.script), EMPTY);
    }
    for (const p of Object.keys(rec)) rec[p].sort();
    return rec;
}

async function collectPrefix(db, byte) {
    const out = [];
    const range = { gte: Buffer.from([byte]), lt: Buffer.from([byte + 1]), keys: true, values: true };
    for await (const [key, value] of db.iterator(range)) {
        out.push(key.toString('hex') + '|' + value.toString('hex'));
    }
    return out.sort();
}

describe('Regression (bulk-sync): seeded records match the live builders for every prefix', function () {
    this.timeout(20000);

    let tmp;
    beforeEach(function () { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-bulk-layout-')); });
    afterEach(function () { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} });

    it('seeds byte-identical keys and values for B/T/I/O/H/J/N/S/W/Z', async function () {
        const dbPath = path.join(tmp, 'db');
        await runMerge(tmp, dbPath);
        const expected = expectedRecords();

        const db = new ClassicLevel(dbPath, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
        await db.open();
        try {
            for (const p of Object.keys(LAYOUT)) {
                // Fail on a prefix the fixture does not cover, so a new one cannot slip in unchecked.
                expect(expected[p], `no expectation for prefix ${p}`).to.be.an('array').that.is.not.empty;
                const seeded = await collectPrefix(db, liveConstants[PREFIX_NAMES[p]]);
                expect(seeded, `prefix ${p}`).to.deep.equal(expected[p]);
            }
        } finally {
            await db.close();
        }
    });
});
