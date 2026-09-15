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
const LevelUpStore = require('../../src/store/level_up_db');

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


let tracker, db, mempoolDb;

function registerTrackerHooks() {
beforeEach(async function () {
    ({ tracker, db, mempoolDb } = await makeTracker());
});

afterEach(async function () {
    sinon.restore();
    try { await db.close(); } catch (_) {}
    try { await mempoolDb.close(); } catch (_) {}
});
}

describe('XChainUtxoTracker (more)', function () {
    this.timeout(15000);
    registerTrackerHooks();

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
});
