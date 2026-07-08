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

// ─── Regression (L-4, bulk-sync residual): coinbase maturity must survive the
//     bulk-sync pipeline ──────────────────────────────────────────────────────
//
// The live indexing path marks coinbase outputs on the O-record (optional 45th
// byte) and getUtxosAddress withholds immature ones. Bulk-sync originally wrote
// fixed 44-byte O-values with no flag, so a coinbase seeded through the bulk
// pipeline was served spendable while still immature (nodes reject the spend).
// These tests drive the real pipeline end to end (writers -> external-sort ->
// anti-join -> derive-keys -> loader -> LevelDB) and query the tracker, proving
// the flag now rides all the way into the O-record. They also prove a legacy
// 120-byte dump (no flag byte) still merges and serves, treated as non-coinbase.

const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const crypto = require('crypto');
const { expect } = require('chai');
const bitcoin = require('bitcoinjs-lib');
const { ClassicLevel } = require('classic-level');

const { OutputsWriter, SpendsWriter, MetaWriter } = require('../../src/bulk-sync/writers.js');
const { externalSort }   = require('../../src/bulk-sync/merger/external-sort.js');
const { leftAntiJoin }   = require('../../src/bulk-sync/merger/streaming-join.js');
const { deriveKeys }     = require('../../src/bulk-sync/merger/derive-keys.js');
const { loadKeys }       = require('../../src/bulk-sync/merger/loader.js');
const { readOutputsRecordSize } = require('../../src/bulk-sync/orchestrator.js');
const LevelUpStore       = require('../../src/LevelUpDb.js');
const XChainUtxoTracker  = require('../../src/XChainUtxoTracker.js');

const OUTPUTS_KEY_SIZE = 12; // txHash8(8) + vout(4)
const SPENDS_KEY_SIZE  = 12;
const HEADER_SIZE      = 64;

// The bitcoinjs network the tracker resolves for bitcoin-regtest. Deriving the
// fixture address from the same network guarantees getUtxosAddress hashes the
// script to the identical O-key the pipeline wrote.
const NETWORK = new XChainUtxoTracker('bitcoin-regtest', '127.0.0.1', '18443', 'u', 'p', 'net-probe', false).network;

// A deterministic P2WPKH address whose scriptHash the O-keys are built on,
// derived the same way getUtxosAddress derives it, so the read matches.
function fixtureAddress() {
    const pubkeyHash = crypto.createHash('sha256').update(Buffer.from('bulk-sync-coinbase-fixture')).digest().subarray(0, 20);
    const payment = bitcoin.payments.p2wpkh({ hash: pubkeyHash, network: NETWORK });
    const script  = bitcoin.address.toOutputScript(payment.address, NETWORK);
    const scriptHash = crypto.createHash('sha256').update(script).digest();
    return { address: payment.address, scriptHash };
}

function fullTxid(ch) { return Buffer.from(ch.repeat(64), 'hex'); }

// Write a legacy 120-byte outputs-*.dat (no coinbase flag byte). Mirrors the
// pre-L-4 writer so we can prove the merger still accepts that width.
function writeLegacyOutputsFile(filePath, records, firstHeight, lastHeight) {
    const RS = 120;
    const header = Buffer.alloc(HEADER_SIZE);
    Buffer.from('XCHNOUT1', 'ascii').copy(header, 0);
    header.writeUInt8(1, 8);   // chain: bitcoin
    header.writeUInt8(3, 9);   // net: regtest
    header.writeUInt16LE(1, 10); // version
    header.writeUInt32LE(firstHeight, 12);
    header.writeUInt32LE(lastHeight, 16);
    header.writeBigUInt64LE(BigInt(records.length), 20);
    header.writeUInt32LE(RS, 28);
    const body = Buffer.alloc(records.length * RS);
    records.forEach((r, i) => {
        const off = i * RS;
        r.fullTxHash.subarray(0, 8).copy(body, off + 0);
        body.writeUInt32BE(r.vout >>> 0, off + 8);
        body.writeBigUInt64BE(BigInt(r.value), off + 12);
        body.writeInt32BE(r.height, off + 20);
        r.fullTxHash.copy(body, off + 24, 0, 32);
        r.scriptHash.copy(body, off + 56, 0, 32);
        r.blockHash.copy(body, off + 88, 0, 32);
    });
    fs.writeFileSync(filePath, Buffer.concat([header, body]));
}

// Run the merge tail (sort -> anti-join -> derive-keys -> loader) over an
// outputs file plus a meta file, loading into a fresh LevelDB at dbPath. The
// record width is read from the outputs header (readOutputsRecordSize), exactly
// as the orchestrator does, so 120- and 121-byte dumps take the same path.
async function runMerge(tmp, outputsPath, metaPath, dbPath) {
    const spendsPath = path.join(tmp, 'spends.dat');
    new SpendsWriter(spendsPath, 'bitcoin', 'regtest', 0, 999).close(); // no spends

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

// Open a tracker whose confirmed store is the on-disk LevelDB the loader wrote.
async function openTracker(dbPath, tipHeight) {
    const tracker = new XChainUtxoTracker('bitcoin-regtest', '127.0.0.1', '18443', 'u', 'p', 'bulk-cb', false);
    const store = new LevelUpStore('bulk-cb-loaded', false);
    store.db = new ClassicLevel(dbPath, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
    await store.db.open();
    const mempoolDb = new LevelUpStore('bulk-cb-mp-' + Date.now() + '-' + Math.random(), true);
    await mempoolDb.createDatabase();
    tracker.db = store;
    tracker.mempoolDb = mempoolDb;
    tracker.coinbaseMaturity = 100;
    tracker.blockchainInfoLastBlock = tipHeight;
    return { tracker, store, mempoolDb };
}

describe('Regression (L-4 bulk-sync): coinbase maturity survives the pipeline', function () {
    this.timeout(20000);

    let tmp;
    beforeEach(function () { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-bulk-cb-')); });
    afterEach(function () { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} });

    it('withholds an immature bulk-seeded coinbase, serves a mature one and a non-coinbase', async function () {
        const { address, scriptHash } = fixtureAddress();
        const blockHash = Buffer.alloc(32, 0x11);

        // tip 150, maturity 100: height 60 -> 91 confs (immature), height 40 ->
        // 111 confs (mature). The non-coinbase is served regardless of confs.
        const outputsPath = path.join(tmp, 'outputs.dat');
        const w = new OutputsWriter(outputsPath, 'bitcoin', 'regtest', 40, 60);
        const A = fullTxid('a'), B = fullTxid('b'), C = fullTxid('c');
        w.append(A.subarray(0, 8), 0, 5000000000n, 60, A, scriptHash, blockHash, true);  // immature coinbase
        w.append(B.subarray(0, 8), 0, 5000000000n, 40, B, scriptHash, blockHash, true);  // mature coinbase
        w.append(C.subarray(0, 8), 0, 5000000000n, 60, C, scriptHash, blockHash, false); // non-coinbase
        w.close();

        const meta = new MetaWriter(path.join(tmp, 'meta.dat'), 'bitcoin', 'regtest', 40, 60);
        meta.writeBlock(40, 1700000000, blockHash, Buffer.alloc(32), [B.subarray(0, 8)]);
        meta.writeBlock(60, 1700000600, Buffer.alloc(32, 0x22), blockHash, [A.subarray(0, 8), C.subarray(0, 8)]);
        meta.close();

        const dbPath = path.join(tmp, 'db');
        const rs = await runMerge(tmp, outputsPath, path.join(tmp, 'meta.dat'), dbPath);
        expect(rs).to.equal(121); // header discriminator picked the coinbase-flagged width

        const { tracker, store, mempoolDb } = await openTracker(dbPath, 150);
        try {
            const utxos = await tracker.getUtxosAddress(address);
            const txids = utxos.map(u => u.txid).sort();
            expect(txids).to.deep.equal([B.toString('hex'), C.toString('hex')].sort());
            expect(txids).to.not.include(A.toString('hex'));
        } finally {
            await store.db.close();
            await mempoolDb.close();
        }
    });

    it('serves a mature coinbase whose flag round-tripped as coinbase=true', async function () {
        const { address, scriptHash } = fixtureAddress();
        const blockHash = Buffer.alloc(32, 0x33);

        const outputsPath = path.join(tmp, 'outputs.dat');
        const w = new OutputsWriter(outputsPath, 'bitcoin', 'regtest', 10, 10);
        const A = fullTxid('a');
        w.append(A.subarray(0, 8), 0, 2500000000n, 10, A, scriptHash, blockHash, true); // mature coinbase
        w.close();

        const meta = new MetaWriter(path.join(tmp, 'meta.dat'), 'bitcoin', 'regtest', 10, 10);
        meta.writeBlock(10, 1700000000, blockHash, Buffer.alloc(32), [A.subarray(0, 8)]);
        meta.close();

        const dbPath = path.join(tmp, 'db');
        await runMerge(tmp, outputsPath, path.join(tmp, 'meta.dat'), dbPath);

        const { tracker, store, mempoolDb } = await openTracker(dbPath, 200); // 191 confs, mature
        try {
            const raw = await store.getOutputsScriptPubKey(scriptHash.toString('hex'));
            expect(raw).to.have.length(1);
            expect(raw[0].coinbase).to.equal(true); // flag survived to the O-record
            const utxos = await tracker.getUtxosAddress(address);
            expect(utxos.map(u => u.txid)).to.include(A.toString('hex'));
        } finally {
            await store.db.close();
            await mempoolDb.close();
        }
    });

    it('a legacy 120-byte dump (no flag byte) still merges and serves as non-coinbase', async function () {
        const { address, scriptHash } = fixtureAddress();
        const blockHash = Buffer.alloc(32, 0x44);
        const A = fullTxid('a');

        const outputsPath = path.join(tmp, 'outputs.dat');
        writeLegacyOutputsFile(outputsPath, [
            { fullTxHash: A, vout: 0, value: 5000000000n, height: 5, scriptHash, blockHash },
        ], 5, 5);
        expect(readOutputsRecordSize(outputsPath)).to.equal(120);

        const meta = new MetaWriter(path.join(tmp, 'meta.dat'), 'bitcoin', 'regtest', 5, 5);
        meta.writeBlock(5, 1700000000, blockHash, Buffer.alloc(32), [A.subarray(0, 8)]);
        meta.close();

        const dbPath = path.join(tmp, 'db');
        const rs = await runMerge(tmp, outputsPath, path.join(tmp, 'meta.dat'), dbPath);
        expect(rs).to.equal(120);

        // tip 10: only 6 confs. A coinbase here would be withheld; because the
        // legacy record carries no flag it decodes as non-coinbase and is served.
        const { tracker, store, mempoolDb } = await openTracker(dbPath, 10);
        try {
            const raw = await store.getOutputsScriptPubKey(scriptHash.toString('hex'));
            expect(raw).to.have.length(1);
            expect(raw[0].coinbase).to.equal(false);
            // The re-encoded on-disk value must be the legacy 44-byte form.
            const oKey = Buffer.concat([Buffer.from([0x4F]), scriptHash, A.subarray(0, 8), Buffer.alloc(4)]);
            const oVal = await store.db.get(oKey);
            expect(oVal.length).to.equal(44);

            const utxos = await tracker.getUtxosAddress(address);
            expect(utxos.map(u => u.txid)).to.include(A.toString('hex'));
        } finally {
            await store.db.close();
            await mempoolDb.close();
        }
    });
});
