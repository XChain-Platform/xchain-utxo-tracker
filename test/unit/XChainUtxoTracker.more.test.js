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

// NOTE: start() (~lines 730-1166) is INTEGRATION-BOUND: it opens an ON-DISK
// LevelDB, enters a while(true) poll loop fetching blocks over JSON-RPC, and
// never returns. It cannot be driven by unit tests without either a real node
// or a complex event-loop trampoline that would still produce unreliable,
// side-effect-prone results. All tests here deliberately avoid calling start().

const { expect } = require('chai');
const sinon = require('sinon');
const crypto = require('crypto');
const XChainUtxoTracker = require('../../src/XChainUtxoTracker');
const LevelUpStore = require('../../src/LevelUpDb');

let _dbCounter = 0;
function uniqueDbName(prefix) {
    return prefix + '-more-' + Date.now() + '-' + (++_dbCounter);
}

function randHash() { return crypto.randomBytes(32).toString('hex'); }
function randHash8() { return crypto.randomBytes(8).toString('hex'); }

function makeTx(opts = {}) {
    const txid = opts.txid || randHash();
    return {
        getId() { return txid; },
        ins: opts.ins || [],
        outs: opts.outs || []
    };
}

function makeOutput(valueSats = 100000000) {
    return {
        value: BigInt(valueSats),
        script: crypto.randomBytes(25)
    };
}

function makeCoinbaseInput() {
    return {
        hash: Buffer.alloc(32, 0),
        index: 4294967295, // 0xFFFFFFFF coinbase sentinel
        script: Buffer.alloc(4)
    };
}

function makeSpendInput(prevTxIdHex, prevVout = 0) {
    const hashBuf = Buffer.from(prevTxIdHex, 'hex').reverse();
    return {
        hash: hashBuf,
        index: prevVout,
        script: Buffer.alloc(0)
    };
}

// Build an in-memory tracker pair, wired up the same way as the main test file.
async function makeTracker() {
    const tracker = new XChainUtxoTracker(
        'bitcoin-regtest', '127.0.0.1', '18443', 'user', 'pass', 'test-db', false
    );
    const db = new LevelUpStore(uniqueDbName('tracker'), true);
    const mempoolDb = new LevelUpStore(uniqueDbName('mempool'), true);
    await db.createDatabase();
    await mempoolDb.createDatabase();
    tracker.db = db;
    tracker.mempoolDb = mempoolDb;
    tracker.blockchainInfoLastBlock = 1000;
    return { tracker, db, mempoolDb };
}

describe('XChainUtxoTracker (more)', function () {
    this.timeout(15000);

    let tracker, db, mempoolDb;

    beforeEach(async function () {
        ({ tracker, db, mempoolDb } = await makeTracker());
    });

    afterEach(async function () {
        sinon.restore();
        try { await db.close(); } catch (_) {}
        try { await mempoolDb.close(); } catch (_) {}
    });

    describe('satoshiToDecimalString', function () {
        const { satoshiToDecimalString } = require('../../src/XChainUtxoTracker');

        it('converts zero', function () {
            expect(satoshiToDecimalString(0n)).to.equal('0.00000000');
        });

        it('converts 1 satoshi', function () {
            expect(satoshiToDecimalString(1n)).to.equal('0.00000001');
        });

        it('converts 1 BTC (100000000 sat)', function () {
            expect(satoshiToDecimalString(100000000n)).to.equal('1.00000000');
        });

        it('converts large DOGE-scale amount', function () {
            // 100M DOGE = 10_000_000_000_000_000 sat, above Number.MAX_SAFE_INTEGER
            const doge100M = 10_000_000_000_000_000n;
            const result = satoshiToDecimalString(doge100M);
            expect(result).to.equal('100000000.00000000');
        });

        it('converts negative satoshis (pending spend)', function () {
            expect(satoshiToDecimalString(-100000000n)).to.equal('-1.00000000');
        });

        it('pads fractional part correctly', function () {
            // 1000 sat = 0.00001000
            expect(satoshiToDecimalString(1000n)).to.equal('0.00001000');
        });
    });

    describe('undoBlocks per-network resolution', function () {
        it('bitcoin-mainnet resolves to BTC default', function () {
            const t = new XChainUtxoTracker('bitcoin-mainnet', '127.0.0.1', '8332', 'u', 'p', 'db', false);
            expect(t.undoBlocks).to.equal(12);
        });

        it('litecoin-mainnet resolves to LTC default', function () {
            const t = new XChainUtxoTracker('litecoin-mainnet', '127.0.0.1', '9332', 'u', 'p', 'db', false);
            expect(t.undoBlocks).to.equal(48);
        });

        it('dogecoin-mainnet resolves to DOGE default', function () {
            const t = new XChainUtxoTracker('dogecoin-mainnet', '127.0.0.1', '22555', 'u', 'p', 'db', false);
            expect(t.undoBlocks).to.equal(120);
        });

        it('unknown network fails loud at construction instead of decoding under a default network', function () {
            // getBitcoinJsNetwork itself now refuses an unresolvable network name
            // (item 5879), so construction stops on the very first line rather than
            // relying on the guard below it; either way an unknown network never
            // gets far enough to decode addresses under bitcoinjs's BTC-mainnet
            // default. The regex spans both messages on purpose.
            expect(() => new XChainUtxoTracker('unknown-mainnet', '127.0.0.1', '1234', 'u', 'p', 'db', false))
                .to.throw(/[Uu]nknown network/);
        });
    });

    describe('getAddressType', function () {
        it('detects P2SH address', function () {
            // P2SH on regtest starts with '2'
            const type = tracker.getAddressType('2MzQwSSnBHWHqSAqtTVQ6v47XtaisrJa1Vc', tracker.network);
            expect(type).to.equal('p2sh');
        });

        it('detects P2TR (taproot) address (regression: needs initEccLib)', function () {
            // src/XChainUtxoTracker.js registers tiny-secp256k1 via bitcoin.initEccLib
            // at module load, so payments.p2tr() works and taproot addresses are
            // classified correctly instead of silently falling through to 'unknown'.
            const bitcoin = require('bitcoinjs-lib');
            const type = tracker.getAddressType(
                'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0',
                bitcoin.networks.bitcoin
            );
            expect(type).to.equal('p2tr');
        });

        it('returns unknown for garbage', function () {
            const type = tracker.getAddressType('zzzznotanaddress', tracker.network);
            expect(type).to.equal('unknown');
        });
    });

    describe('millisecondsToTimeString', function () {
        it('formats sub-second only', function () {
            const s = tracker.millisecondsToTimeString(500);
            expect(s).to.equal('00h00m00.5s');
        });

        it('formats 0ms', function () {
            const s = tracker.millisecondsToTimeString(0);
            expect(s).to.equal('00h00m00.0s');
        });

        it('exactly 1 day', function () {
            const s = tracker.millisecondsToTimeString(86400000);
            expect(s).to.include('1d');
            expect(s).to.include('00h00m00.0s');
        });
    });

    describe('addToLastBlocks deletedTransactionArray cleanup', function () {
        it('removes block from deletedTransactionArray when it ages out', async function () {
            // Fill lastBlocks to capacity by setting undoBlocks=2 then adding 3 blocks.
            // When the 3rd is added, the oldest shifts out and should be removed from
            // deletedTransactionArray if present (lines 159-161).
            tracker.undoBlocks = 2;

            const h1 = randHash();
            const h2 = randHash();
            const h3 = randHash();

            // Begin transaction FIRST (sets deletedTransactionArray to a new Map),
            // then inject h1 into it to simulate a same-block spend record.
            await db.beginTransaction();
            db.deletedTransactionArray.set(h1, new Map());

            await tracker.addToLastBlocks(h1);
            await tracker.addToLastBlocks(h2);
            // Adding h3 causes h1 to shift out; the code should delete h1 from the Map
            await tracker.addToLastBlocks(h3);

            // Check before endTransaction nulls the map
            expect(db.deletedTransactionArray.has(h1)).to.be.false;
            // h1 should be in pendingKMCleanup
            expect(tracker.pendingKMCleanup).to.include(h1);
            // lastBlocks should only have h2 and h3
            expect(tracker.lastBlocks).to.deep.equal([h2, h3]);

            await db.endTransaction(true);
        });
    });

    describe('cleanupAgedBlocks', function () {
        it('is a no-op when pendingKMCleanup is empty', async function () {
            tracker.pendingKMCleanup = [];
            // Should not throw or touch db
            const beginSpy = sinon.spy(db, 'beginTransaction');
            await tracker.cleanupAgedBlocks();
            expect(beginSpy.called).to.be.false;
        });

        it('clears pendingKMCleanup and processes each block', async function () {
            const h1 = randHash();
            const h2 = randHash();
            tracker.pendingKMCleanup = [h1, h2];

            const processStub = sinon.stub(db, 'processDeletedOutputs').resolves();
            const removeStub = sinon.stub(db, 'removeLastStoredBlock').resolves();

            await tracker.cleanupAgedBlocks();

            expect(processStub.callCount).to.equal(2);
            expect(removeStub.callCount).to.equal(2);
            expect(tracker.pendingKMCleanup).to.deep.equal([]);
        });
    });

    describe('loadLastBlocksSortedByHeight', function () {
        it('returns hashes sorted by ascending height', async function () {
            const h100 = randHash();
            const h200 = randHash();
            const h50 = randHash();

            await db.beginTransaction();
            await db.insertBlock({ hash: h100, height: 100, timestamp: 0, previousHash: randHash() });
            await db.insertBlock({ hash: h200, height: 200, timestamp: 0, previousHash: randHash() });
            await db.insertBlock({ hash: h50,  height: 50,  timestamp: 0, previousHash: randHash() });
            db.addLastStoredBlock(h100);
            db.addLastStoredBlock(h200);
            db.addLastStoredBlock(h50);
            await db.endTransaction();

            const sorted = await tracker.loadLastBlocksSortedByHeight();
            const idx50  = sorted.indexOf(h50);
            const idx100 = sorted.indexOf(h100);
            const idx200 = sorted.indexOf(h200);

            expect(idx50).to.be.lessThan(idx100);
            expect(idx100).to.be.lessThan(idx200);
        });

        it('returns empty array when no stored blocks', async function () {
            const sorted = await tracker.loadLastBlocksSortedByHeight();
            expect(sorted).to.deep.equal([]);
        });

        it('handles a block missing from B-records (height=-1)', async function () {
            const h1 = randHash();
            const h2 = randHash();

            // Only insert a B-record for h2
            await db.beginTransaction();
            await db.insertBlock({ hash: h2, height: 99, timestamp: 0, previousHash: randHash() });
            db.addLastStoredBlock(h1); // no B-record → height=-1
            db.addLastStoredBlock(h2);
            await db.endTransaction();

            const sorted = await tracker.loadLastBlocksSortedByHeight();
            // h1 (height=-1) must come before h2 (height=99)
            expect(sorted.indexOf(h1)).to.be.lessThan(sorted.indexOf(h2));
        });
    });

    describe('parseTransaction', function () {
        it('inserts transaction record when removeSpent=false', async function () {
            const tx = makeTx({ ins: [makeCoinbaseInput()], outs: [makeOutput(1000)] });
            const txid = tx.getId();
            const blockHash = randHash();

            await db.beginTransaction();
            const info = await tracker.parseTransaction(db, tx, blockHash, 10, false, false);
            await db.endTransaction(true);

            expect(info.outputsCount).to.equal(1);
            const txs = await db.getTransactions(txid.substring(0, 16));
            expect(txs).to.have.length(1);
        });

        it('does NOT insert transaction record when removeSpent=true', async function () {
            const tx = makeTx({ ins: [makeCoinbaseInput()], outs: [makeOutput(1000)] });
            const txid = tx.getId();
            const blockHash = randHash();

            await db.beginTransaction();
            const info = await tracker.parseTransaction(db, tx, blockHash, 10, false, true);
            await db.endTransaction(true);

            expect(info.outputsCount).to.equal(1);
            const txs = await db.getTransactions(txid.substring(0, 16));
            expect(txs).to.be.empty;
        });

        it('skips coinbase input and counts 0 inputs', async function () {
            const tx = makeTx({ ins: [makeCoinbaseInput()], outs: [makeOutput(5000)] });

            await db.beginTransaction();
            const info = await tracker.parseTransaction(db, tx, randHash(), 5, false, false);
            await db.endTransaction(true);

            expect(info.inputsCount).to.equal(0);
        });

        it('counts non-coinbase inputs', async function () {
            const prevId = randHash();
            const tx = makeTx({ ins: [makeSpendInput(prevId, 0)], outs: [makeOutput(999)] });

            await db.beginTransaction();
            const info = await tracker.parseTransaction(db, tx, randHash(), 5, false, false);
            await db.endTransaction(true);

            expect(info.inputsCount).to.equal(1);
        });

        it('uses transaction.id when present (AuxPoW renamed id)', async function () {
            const customId = randHash();
            const tx = {
                id: customId,
                ins: [makeCoinbaseInput()],
                outs: [makeOutput(1000)]
            };

            await db.beginTransaction();
            const info = await tracker.parseTransaction(db, tx, randHash(), 5, false, false);
            await db.endTransaction(true);

            const txs = await db.getTransactions(customId.substring(0, 16));
            expect(txs).to.have.length(1);
        });

        it('inserts hints when addHints=true', async function () {
            const prevId = randHash();
            const tx = makeTx({
                ins: [makeSpendInput(prevId, 0)],
                outs: [makeOutput(500)]
            });

            await db.beginTransaction();
            const info = await tracker.parseTransaction(db, tx, randHash(), 7, true, false);
            await db.endTransaction(true);

            expect(info.inputsCount).to.equal(1);
            expect(info.outputsCount).to.equal(1);
        });

        it('calls removeOutputWithInput when removeSpent=true (non-coinbase)', async function () {
            const prevId = randHash();
            const tx = makeTx({
                ins: [makeSpendInput(prevId, 0)],
                outs: [makeOutput(500)]
            });

            const removeStub = sinon.stub(db, 'removeOutputWithInput').resolves();

            await db.beginTransaction();
            await tracker.parseTransaction(db, tx, randHash(), 7, false, true);
            await db.endTransaction(true);

            expect(removeStub.calledOnce).to.be.true;
        });

        it('skips non-standard inputs (standard_input=false)', async function () {
            const tx = makeTx({
                ins: [{ hash: Buffer.alloc(32), index: 0, script: Buffer.alloc(0), standard_input: false }],
                outs: [makeOutput(100)]
            });

            await db.beginTransaction();
            const info = await tracker.parseTransaction(db, tx, randHash(), 1, false, false);
            await db.endTransaction(true);

            expect(info.inputsCount).to.equal(0);
        });
    });

    describe('parseTxOutputs (additional)', function () {
        it('uses tx.id when present', async function () {
            const customId = randHash();
            const tx = {
                id: customId,
                ins: [],
                outs: [makeOutput(1000)]
            };

            await db.beginTransaction();
            const count = await tracker.parseTxOutputs(db, tx, randHash(), 10, false, false);
            await db.endTransaction(true);

            expect(count).to.equal(1);
            const txs = await db.getTransactions(customId.substring(0, 16));
            expect(txs).to.have.length(1);
        });

        it('inserts output hints when addHints=true (even removeSpent=false)', async function () {
            const tx = makeTx({ outs: [makeOutput(2000)] });
            const blockHash = randHash();

            await db.beginTransaction();
            await tracker.parseTxOutputs(db, tx, blockHash, 10, true, false);
            await db.endTransaction(true);

            const scriptHash = crypto.createHash('sha256').update(tx.outs[0].script).digest('hex');
            const outputs = await db.getOutputsScriptPubKey(scriptHash);
            expect(outputs).to.have.length(1);
        });

        it('returns 0 for a tx with no outputs', async function () {
            const tx = makeTx({ outs: [] });

            await db.beginTransaction();
            const count = await tracker.parseTxOutputs(db, tx, randHash(), 10, false, false);
            await db.endTransaction(true);

            expect(count).to.equal(0);
        });
    });

    describe('parseTxInputs (additional)', function () {
        it('skips non-standard inputs', async function () {
            const tx = makeTx({
                ins: [{ hash: Buffer.alloc(32), index: 0, script: Buffer.alloc(0), standard_input: false }]
            });

            await db.beginTransaction();
            const count = await tracker.parseTxInputs(db, tx, randHash(), false, false);
            await db.endTransaction(true);

            expect(count).to.equal(0);
        });

        it('calls insertInputHint when addHints=true', async function () {
            const prevId = randHash();
            const tx = makeTx({ ins: [makeSpendInput(prevId, 1)] });

            const hintStub = sinon.stub(db, 'insertInputHint').resolves();

            await db.beginTransaction();
            const count = await tracker.parseTxInputs(db, tx, randHash(), true, false);
            await db.endTransaction(true);

            expect(count).to.equal(1);
            expect(hintStub.calledOnce).to.be.true;
        });

        it('uses tx.id when present', async function () {
            const customId = randHash();
            const prevId = randHash();
            const tx = {
                id: customId,
                ins: [makeSpendInput(prevId, 0)],
                outs: []
            };

            await db.beginTransaction();
            const count = await tracker.parseTxInputs(db, tx, randHash(), false, false);
            await db.endTransaction(true);

            expect(count).to.equal(1);
        });

        it('calls removeOutputWithInput when removeSpent=true', async function () {
            const prevId = randHash();
            const tx = makeTx({ ins: [makeSpendInput(prevId, 0)] });
            const removeStub = sinon.stub(db, 'removeOutputWithInput').resolves();

            await db.beginTransaction();
            await tracker.parseTxInputs(db, tx, randHash(), false, true);
            await db.endTransaction(true);

            expect(removeStub.calledOnce).to.be.true;
        });
    });

    describe('getBalanceInfo (mempool-spent mempool output)', function () {
        it('excludes mempool output spent by another mempool input', async function () {
            const bitcoin = require('bitcoinjs-lib');
            const { createHash } = require('crypto');
            const address = 'n1wgm6kkzMcNfAtJmes8YhpvtDzdNhDY5a';
            const script = bitcoin.address.toOutputScript(address, tracker.network);
            const scriptHash = createHash('sha256').update(script).digest('hex');

            const fullTxHash = randHash();
            const txHash8 = fullTxHash.substring(0, 16);

            // Insert mempool output in one transaction
            await mempoolDb.beginTransaction();
            await mempoolDb.insertOutput({
                scriptPubKey: scriptHash,
                txHash: txHash8,
                outputIndex: 0,
                value: BigInt('75000000'),
                height: -1,
                fullTxHash
            });
            // Also insert mempool input spending it in the same transaction
            await mempoolDb.insertInput({
                prevTxHash: fullTxHash,
                prevOutputIndex: 0,
                txHash: randHash8()
            });
            await mempoolDb.endTransaction(true);

            const info = await tracker.getBalanceInfo(address);
            // The mempool output is being spent → should NOT count as pending income
            expect(info.balances.pending).to.equal('0.00000000');
            expect(info.utxos.pending).to.equal(0);
        });
    });

    describe('getUtxosAddress pagination', function () {
        it('limits results and sets nextCursor', async function () {
            const bitcoin = require('bitcoinjs-lib');
            const { createHash } = require('crypto');
            const address = 'n1wgm6kkzMcNfAtJmes8YhpvtDzdNhDY5a';
            const script = bitcoin.address.toOutputScript(address, tracker.network);
            const scriptHash = createHash('sha256').update(script).digest('hex');

            // Insert 3 confirmed outputs in a single transaction
            await db.beginTransaction();
            for (let i = 0; i < 3; i++) {
                const fh = randHash();
                await db.insertOutput({
                    scriptPubKey: scriptHash,
                    txHash: fh.substring(0, 16),
                    outputIndex: i,
                    value: BigInt('10000000'),
                    height: 100 + i,
                    fullTxHash: fh
                });
            }
            await db.endTransaction(true);

            const page1 = await tracker.getUtxosAddress(address, { limit: 2 });
            expect(page1).to.have.length(2);
            // nextCursor is non-enumerable; access directly
            expect(page1.nextCursor).to.be.a('string');
        });

        it('returns mempool outputs only on first page (after=null)', async function () {
            const bitcoin = require('bitcoinjs-lib');
            const { createHash } = require('crypto');
            const address = 'n1wgm6kkzMcNfAtJmes8YhpvtDzdNhDY5a';
            const script = bitcoin.address.toOutputScript(address, tracker.network);
            const scriptHash = createHash('sha256').update(script).digest('hex');

            const mFh = randHash();
            await mempoolDb.beginTransaction();
            await mempoolDb.insertOutput({
                scriptPubKey: scriptHash,
                txHash: mFh.substring(0, 16),
                outputIndex: 0,
                value: BigInt('5000000'),
                height: -1,
                fullTxHash: mFh
            });
            await mempoolDb.endTransaction(true);

            // First page (after=null): should include mempool output
            const page1 = await tracker.getUtxosAddress(address, { limit: 10, after: null });
            expect(page1.some(u => u.confirmations === 0)).to.be.true;

            // Second page (after=validCursor): should NOT include mempool.
            // Cursor format must be "<txHash8Hex>:<vout>"; use a valid but non-existent one.
            const validCursor = randHash8() + ':0';
            const page2 = await tracker.getUtxosAddress(address, { limit: 10, after: validCursor });
            expect(page2.every(u => u.confirmations !== 0)).to.be.true;
        });

        it('throws on pre-migration mempool output missing fullTxHash', async function () {
            const bitcoin = require('bitcoinjs-lib');
            const { createHash } = require('crypto');
            const address = 'n1wgm6kkzMcNfAtJmes8YhpvtDzdNhDY5a';
            const script = bitcoin.address.toOutputScript(address, tracker.network);
            const scriptHash = createHash('sha256').update(script).digest('hex');

            // Insert mempool output WITHOUT fullTxHash
            await mempoolDb.insertOutput({
                scriptPubKey: scriptHash,
                txHash: randHash8(),
                outputIndex: 0,
                value: BigInt('100000000'),
                height: -1
            });
            await mempoolDb.endTransaction(true);

            let threw = null;
            try {
                await tracker.getUtxosAddress(address);
            } catch (e) {
                threw = e;
            }
            expect(threw).to.not.be.null;
            expect(threw.message).to.match(/fullTxHash/);
            expect(threw.message).to.match(/re-index/i);
        });
    });

    describe('updateMempool', function () {
        beforeEach(function () {
            // Fast-path sleep for all updateMempool tests
            sinon.stub(tracker, 'sleep').resolves();
        });

        it('returns immediately and logs when mempoolBusy=true', async function () {
            tracker.mempoolBusy = true;
            const getRawStub = sinon.stub(tracker.connector, 'getRawMempool');

            await tracker.updateMempool();

            // mempoolBusy should stay true (set by caller, not by this path)
            expect(tracker.mempoolBusy).to.be.true;
            // Should NOT have called getRawMempool
            expect(getRawStub.called).to.be.false;
        });

        it('happy path: processes empty mempool (no new txs)', async function () {
            sinon.stub(tracker.connector, 'getRawMempool').resolves([]);
            sinon.stub(tracker.connector, 'getRawTransactions').resolves([]);

            await tracker.updateMempool();

            expect(tracker.mempoolBusy).to.be.false;
        });

        it('happy path: processes a mempool tx (mocked txFromHex)', async function () {
            const txid = randHash();
            sinon.stub(tracker.connector, 'getRawMempool').resolves([txid]);
            sinon.stub(tracker.connector, 'getRawTransactions').resolves(['fakehex']);

            const mockTx = makeTx({ ins: [makeCoinbaseInput()], outs: [makeOutput(1000)] });
            sinon.stub(tracker.xchainBlockDecoder, 'txFromHex').returns(mockTx);

            await tracker.updateMempool();

            expect(tracker.mempoolBusy).to.be.false;
        });

        it('getRawMempool throws → logs error and resets mempoolBusy', async function () {
            sinon.stub(tracker.connector, 'getRawMempool').rejects(new Error('node down'));

            await tracker.updateMempool();

            expect(tracker.mempoolBusy).to.be.false;
        });

        it('getRawTransactions fails MEMPOOL_MAX_TX_FETCH_RETRIES times → breaks and resets mempoolBusy', async function () {
            const RETRIES = 5; // MEMPOOL_MAX_TX_FETCH_RETRIES constant
            const txid = randHash();
            sinon.stub(tracker.connector, 'getRawMempool').resolves([txid]);
            sinon.stub(tracker.connector, 'getRawTransactions').rejects(new Error('rpc error'));

            await tracker.updateMempool();

            // After RETRIES failures it should break out (not hang forever).
            expect(tracker.mempoolBusy).to.be.false;
            // Sleep runs after each failure except the bail-out attempt: 5 failures,
            // breaks on attempt 5, so sleep is called on failures 1-4.
            expect(tracker.sleep.callCount).to.be.at.least(RETRIES - 1);
        });

        it('null entry in getRawTransactions result is skipped', async function () {
            const txid = randHash();
            sinon.stub(tracker.connector, 'getRawMempool').resolves([txid]);
            // Return an array with a null entry
            sinon.stub(tracker.connector, 'getRawTransactions').resolves([null]);

            // parseTransaction should NOT be called for null entries
            const parseSpy = sinon.spy(tracker, 'parseTransaction');

            await tracker.updateMempool();

            expect(tracker.mempoolBusy).to.be.false;
            expect(parseSpy.called).to.be.false;
        });

        it('parse path throws → outer catch resets mempoolBusy', async function () {
            const txid = randHash();
            sinon.stub(tracker.connector, 'getRawMempool').resolves([txid]);
            sinon.stub(tracker.connector, 'getRawTransactions').resolves(['badhex']);
            // Force txFromHex to throw, triggering the outer catch block
            sinon.stub(tracker.xchainBlockDecoder, 'txFromHex').throws(new Error('decode error'));

            await tracker.updateMempool();

            expect(tracker.mempoolBusy).to.be.false;
        });

        it('calls deleteAndCompareTxsNotInList to remove stale mempool txs', async function () {
            sinon.stub(tracker.connector, 'getRawMempool').resolves([]);
            const delStub = sinon.stub(mempoolDb, 'deleteAndCompareTxsNotInList').resolves({
                transactionsDeleted: 0, inputsDeleted: 0, outputsDeleted: 0
            });

            await tracker.updateMempool();

            expect(delStub.calledOnce).to.be.true;
            expect(tracker.mempoolBusy).to.be.false;
        });

        it('resets mempoolBusy when deleteAndCompareTxsNotInList throws', async function () {
            sinon.stub(tracker.connector, 'getRawMempool').resolves([]);
            sinon.stub(mempoolDb, 'deleteAndCompareTxsNotInList').rejects(new Error('db fault'));

            await tracker.updateMempool();

            expect(tracker.mempoolBusy).to.be.false;
        });

        it('multi-batch: logs estimate and sleeps between batches when rawMempool > MEMPOOL_BATCH_SIZE', async function () {
            // MEMPOOL_BATCH_SIZE=1000; provide 1001 txids to trigger the multi-batch path
            // (lines 1224-1228 and 1284-1286).
            const BATCH_SIZE = 1000;
            const txids = Array.from({ length: BATCH_SIZE + 1 }, () => randHash());
            sinon.stub(tracker.connector, 'getRawMempool').resolves(txids.slice());
            // Both batches return empty so parseTransaction is never called
            sinon.stub(tracker.connector, 'getRawTransactions').resolves([]);
            sinon.stub(mempoolDb, 'deleteAndCompareTxsNotInList').resolves({
                transactionsDeleted: 0, inputsDeleted: 0, outputsDeleted: 0
            });

            await tracker.updateMempool();

            expect(tracker.mempoolBusy).to.be.false;
            // The inter-batch sleep should have been called at least once (between batch 1 and 2)
            expect(tracker.sleep.callCount).to.be.at.least(1);
        });
    });

    describe('verifyReorg: height mismatch (db recovery branch)', function () {
        it('fixes mismatched lastBlockIndex and continues when lastBlock exists and heights are consistent', async function () {
            let callCount = 0;
            tracker.undoBlocks = 1000;
            sinon.stub(tracker, 'sleep').resolves();

            // First pass: lastBlockIndex(100) != lastBlock.h(99); triggers the fix branch.
            // Second pass: heights agree and node hash matches → thereAreDifferences = false.
            tracker.db = {
                getLastBlockHeight: sinon.stub()
                    .onFirstCall().resolves(100)
                    .onSecondCall().resolves(99),
                getLastBlockHash: sinon.stub()
                    .onFirstCall().resolves('hash100')
                    .onSecondCall().resolves('hash99'),
                getBlock: sinon.stub()
                    .onFirstCall().resolves({ h: 99 })   // mismatch: index=100, block.h=99
                    .onSecondCall().resolves({ h: 99 }),  // second pass: match
                getLastBlock: sinon.stub().resolves({ hash: 'hash99', height: 99 }),
                setLastBlockHash: sinon.stub().resolves(),
                setLastBlockHeight: sinon.stub().resolves(),
                // The pointer-repair branch now commits its writes in its own batch
                // so they reach disk before the loop re-reads the pointer.
                beginTransaction: sinon.stub().resolves(),
                endTransaction: sinon.stub().resolves()
            };
            tracker.connector = {
                getBlockHash: sinon.stub().resolves('hash99')
            };

            const result = await tracker.verifyReorg();
            expect(result).to.be.true;
            expect(tracker.db.setLastBlockHash.calledWith('hash99')).to.be.true;
        });

        it('throws when lastBlock exists but getLastBlock height is inconsistent', async function () {
            tracker.undoBlocks = 1000;
            sinon.stub(tracker, 'sleep').resolves();

            tracker.db = {
                getLastBlockHeight: sinon.stub().resolves(100),
                getLastBlockHash: sinon.stub().resolves('hash100'),
                // lastBlock.h=90 but index=100 → triggers inconsistency branch
                getBlock: sinon.stub().resolves({ h: 90 }),
                getLastBlock: sinon.stub().resolves({ hash: 'hashX', height: 95 }) // 95 != 90
            };

            let threw = false;
            try {
                await tracker.verifyReorg();
            } catch (err) {
                threw = true;
                expect(err.message).to.match(/inconsistent/i);
            }
            expect(threw).to.be.true;
        });

        it('handles null lastBlock (no block record) → fixes via getLastBlock', async function () {
            tracker.undoBlocks = 1000;
            sinon.stub(tracker, 'sleep').resolves();

            let pass = 0;
            tracker.db = {
                getLastBlockHeight: sinon.stub()
                    .onFirstCall().resolves(50)
                    .onSecondCall().resolves(50),
                getLastBlockHash: sinon.stub()
                    .onFirstCall().resolves('hashX')
                    .onSecondCall().resolves('hash50'),
                // First call: null (missing block) → triggers mismatch branch
                // Second call: real block
                getBlock: sinon.stub()
                    .onFirstCall().resolves(null)
                    .onSecondCall().resolves({ h: 50 }),
                getLastBlock: sinon.stub().resolves({ hash: 'hash50', height: 50 }),
                setLastBlockHash: sinon.stub().resolves(),
                setLastBlockHeight: sinon.stub().resolves(),
                // Pointer-repair branch commits its writes in its own batch now.
                beginTransaction: sinon.stub().resolves(),
                endTransaction: sinon.stub().resolves()
            };
            tracker.connector = {
                getBlockHash: sinon.stub().resolves('hash50')
            };

            const result = await tracker.verifyReorg();
            expect(result).to.be.true;
        });

        it('handles getBlockHash throwing (node error) → sleeps and retries', async function () {
            tracker.undoBlocks = 1000;

            let nodeCallCount = 0;
            tracker.db = {
                getLastBlockHeight: sinon.stub().resolves(10),
                getLastBlockHash: sinon.stub().resolves('hash10'),
                getBlock: sinon.stub().resolves({ h: 10 })
            };
            tracker.connector = {
                getBlockHash: sinon.stub()
                    .onFirstCall().rejects(new Error('connection refused'))
                    .onSecondCall().resolves('hash10')
            };
            const sleepStub = sinon.stub(tracker, 'sleep').resolves();

            const result = await tracker.verifyReorg();
            expect(result).to.be.true;
            expect(sleepStub.calledOnce).to.be.true;
        });

        it('throws when reorg depth exceeds undoBlocks', async function () {
            tracker.undoBlocks = 1;
            sinon.stub(tracker, 'sleep').resolves();
            tracker.removeFromLastBlocks = sinon.stub().resolves();

            const orphanHash = 'orphan1';
            tracker.db = {
                getLastBlockHeight: sinon.stub().resolves(10),
                getLastBlockHash: sinon.stub().resolves(orphanHash),
                getBlock: sinon.stub().resolves({ h: 10, ph: 'parent0' }),
                beginTransaction: sinon.stub().resolves(),
                endTransaction: sinon.stub().resolves(),
                removeOutputScriptsInBlock: sinon.stub().resolves(),
                processDeletedOutputs: sinon.stub().resolves(),
                removeCreatedOutputsInBlock: sinon.stub().resolves(),
                deleteBlock: sinon.stub().resolves(),
                setLastBlockHash: sinon.stub().resolves(),
                setLastBlockHeight: sinon.stub().resolves()
            };
            tracker.connector = {
                getBlockHash: sinon.stub().resolves('node_hash_10')
            };

            let threw = false;
            try {
                await tracker.verifyReorg();
            } catch (err) {
                threw = true;
                expect(err.message).to.match(/exceeds the recovery window/i);
            }
            expect(threw).to.be.true;
        });
    });

    describe('stopParsing (mempoolInterval cleanup)', function () {
        it('clears mempoolInterval on a successful stop', async function () {
            const fakeInterval = setInterval(() => {}, 99999);
            tracker.mempoolInterval = fakeInterval;
            // parsingStopped already true: the stop succeeds immediately.
            tracker.parsingStopped = true;
            sinon.stub(tracker, 'sleep').resolves();

            const result = await tracker.stopParsing();
            expect(result).to.be.true;
            // A successful stop tears the poller down and leaves it null.
            expect(tracker.mempoolInterval).to.be.null;
            clearInterval(fakeInterval);
        });

        it('re-arms the mempool poller and stays running on a failed (timed-out) stop', async function () {
            const fakeInterval = setInterval(() => {}, 99999);
            tracker.mempoolInterval = fakeInterval;
            tracker.parsingStopped = false;
            sinon.stub(tracker, 'sleep').resolves();

            let rejected = false;
            try {
                await tracker.stopParsing();
            } catch (_) {
                rejected = true;
            }

            // A failed stop must NOT leave the tracker half-dead: keepParsing is
            // restored and the mempool poller is re-armed (non-null) so the still-
            // running loop keeps serving queries instead of closing its DB.
            expect(rejected).to.be.true;
            expect(tracker.keepParsing).to.be.true;
            expect(tracker.mempoolInterval).to.not.be.null;
            clearInterval(fakeInterval);
            if (tracker.mempoolInterval) { clearInterval(tracker.mempoolInterval); tracker.mempoolInterval = null; }
        });
    });

    describe('isSynced', function () {
        it('reflects tracker.synced field', function () {
            tracker.synced = false;
            expect(tracker.isSynced()).to.be.false;
            tracker.synced = true;
            expect(tracker.isSynced()).to.be.true;
        });
    });

    describe('constructor defaults', function () {
        // auxPow now derives from the coin's wireFormat alone, so the
        // passed flag is inert. Bitcoin is false either way; dogecoin is true either way.
        it('sets auxPow from the coin wireFormat, not the passed flag', function () {
            const t1 = new XChainUtxoTracker('bitcoin-regtest', '127.0.0.1', '18443', 'u', 'p', 'db', true);
            expect(t1.auxPow).to.be.false;

            const t2 = new XChainUtxoTracker('bitcoin-regtest', '127.0.0.1', '18443', 'u', 'p', 'db', false);
            expect(t2.auxPow).to.be.false;

            const t3 = new XChainUtxoTracker('dogecoin-regtest', '127.0.0.1', '18443', 'u', 'p', 'db', false);
            expect(t3.auxPow).to.be.true;
        });

        it('initializes mempoolBusy to false', function () {
            expect(tracker.mempoolBusy).to.be.false;
        });

        it('initializes keepParsing to true', function () {
            expect(tracker.keepParsing).to.be.true;
        });

        it('initializes pendingKMCleanup to empty array', function () {
            expect(tracker.pendingKMCleanup).to.deep.equal([]);
        });
    });
});
