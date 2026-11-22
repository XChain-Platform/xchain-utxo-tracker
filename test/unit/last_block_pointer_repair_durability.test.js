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

// Regression: a LAST_BLOCK_* pointer repair that logs "Last block index was
// fixed!" and never reaches disk.
//
// setLastBlockHash/Height STAGE into LevelUpStore.transactionArray rather than
// writing through, and that Map is live from CONSTRUCTION. At boot nothing has
// called begin/endTransaction yet, so a repair written with bare setters lands
// in a Map the next beginTransaction() replaces wholesale. The durable pointer
// then stays above the node tip while the in-memory cursor reads correct:
// get_sync_status / computeFreshness see the negative lag and floor `synced` to
// false, and if the loop then sleeps synced nothing flushes, so the wrong
// pointer survives every restart (each one re-runs the same ineffective repair).
//
// verifyReorg's repair branch was fixed for this; start()'s sibling branch was
// not. Both now go through commitLastBlockPointerRepair.
//
// The CONTROL below is the pre-fix form itself, run against the same store: it
// must LOSE the pointer, or this file proves nothing about durability.

const { expect } = require('chai');
const LevelUpStore = require('../../src/store/level_up_db');
const XChainUtxoTracker = require('../../src/XChainUtxoTracker');
const fs = require('fs');
const path = require('path');

const HASH = 'b'.repeat(64);
const HEIGHT = 4242;

// Boot state, exactly: a freshly constructed store whose transactionArray is the
// still-live constructor Map, with no begin/endTransaction ever called.
async function bootStore() {
    const db = new LevelUpStore('pointer-repair-' + Date.now() + '-' + Math.random(), true);
    await db.createDatabase();
    expect(db.transactionArray, 'the constructor Map must still be live, or this test is not at boot')
        .to.be.instanceOf(Map);
    return db;
}

describe('LAST_BLOCK_* pointer repair reaches disk', function () {

    it('CONTROL: the pre-fix bare setters stage into the constructor Map and are lost', async function () {
        const db = await bootStore();
        // Verbatim pre-fix repair body.
        await db.setLastBlockHash(HASH);
        await db.setLastBlockHeight(HEIGHT);
        // What the block loop does next.
        await db.beginTransaction();
        expect(await db.getLastBlockHeight()).to.equal(-1);
        expect(await db.getLastBlockHash()).to.equal(null);
        await db.close();
    });

    it('commitLastBlockPointerRepair survives the loop reopening a batch', async function () {
        const db = await bootStore();
        const tracker = Object.create(XChainUtxoTracker.prototype);
        tracker.db = db;

        await tracker.commitLastBlockPointerRepair(HASH, HEIGHT);
        // Readable from disk BEFORE anything else flushes: the repair branch
        // `continue`s straight back into a loop that re-reads these from disk.
        expect(await db.getLastBlockHeight()).to.equal(HEIGHT);
        expect(await db.getLastBlockHash()).to.equal(HASH);

        await db.beginTransaction();
        expect(await db.getLastBlockHeight()).to.equal(HEIGHT);
        expect(await db.getLastBlockHash()).to.equal(HASH);
        await db.close();
    });
});

describe('LAST_BLOCK_* pointer repair counter', function () {

    it('does not count a repair whose durable commit fails', async function () {
        const { tracker, db } = scanRepairTracker();
        db.endTransaction = async () => { throw new Error('commit failed'); };

        let failure;
        try {
            await tracker.verifyReorg();
        } catch (error) {
            failure = error;
        }
        expect(failure).to.be.an('error').with.property('message', 'commit failed');
        expect(tracker.lastBlockPointerRepairCount).to.equal(0);
    });

    it('counts one committed scan repair of a pointer naming a missing block', async function () {
        const { tracker } = scanRepairTracker();
        expect(await tracker.verifyReorg()).to.equal(true);
        expect(tracker.lastBlockPointerRepairCount).to.equal(1);
    });

    it('tells a pointer already on the committed tip from one that must move', async function () {
        const db = await bootStore();
        const tracker = Object.create(XChainUtxoTracker.prototype);
        tracker.db = db;
        expect(await tracker.lastBlockPointerNames(HASH, HEIGHT)).to.equal(false);
        await tracker.commitLastBlockPointerRepair(HASH, HEIGHT);
        expect(await tracker.lastBlockPointerNames(HASH, HEIGHT)).to.equal(true);
        expect(await tracker.lastBlockPointerNames(HASH, HEIGHT - 1)).to.equal(false);
        expect(await tracker.lastBlockPointerNames('c'.repeat(64), HEIGHT)).to.equal(false);
        await db.close();
    });
});

// A tracker whose stored pointer names a block missing from the index, so
// verifyReorg takes the scan repair once and then finds the node agreeing.
function scanRepairTracker() {
    const tracker = new XChainUtxoTracker(
        'bitcoin-regtest', '127.0.0.1', '18443', 'user', 'pass', 'test-db', false);
    tracker.undoBlocks = 1000;
    tracker.sleep = async () => {};
    const pointer = { hash: 'a'.repeat(64), height: HEIGHT };
    const db = {
        getLastBlockHeight: async () => pointer.height,
        getLastBlockHash: async () => pointer.hash,
        getBlock: async (hash) => (hash === HASH ? { h: HEIGHT } : null),
        getLastBlock: async () => ({ hash: HASH, height: HEIGHT }),
        beginTransaction: async () => {},
        setLastBlockHash: async (hash) => { db.staged = hash; },
        setLastBlockHeight: async () => {},
        endTransaction: async () => { pointer.hash = db.staged; },
    };
    tracker.db = db;
    tracker.connector = { getBlockHash: async () => HASH };
    return { tracker, db };
}

describe('LAST_BLOCK_* pointer repair reaches disk', function () {

    it('leaves no batch open for the caller to strand', async function () {
        const db = await bootStore();
        const tracker = Object.create(XChainUtxoTracker.prototype);
        tracker.db = db;
        await tracker.commitLastBlockPointerRepair(HASH, HEIGHT);
        expect(db.transactionArray).to.equal(null);
        await db.close();
    });

    // Both repair sites must route through the helper. Without this the start()
    // branch could quietly regrow its own bare-setter copy, which is exactly how
    // the two sites drifted apart the first time: the fix landed in one.
    it('neither repair site writes the pointer with bare setters', function () {
        const entrySrc = fs.readFileSync(
            path.join(__dirname, '../../src/XChainUtxoTracker.js'), 'utf8');
        const lastBlocksWindowSrc = fs.readFileSync(
            path.join(__dirname, '../../src/XChainUtxoTracker/last_blocks_window.js'), 'utf8');
        const reorgVerificationSrc = fs.readFileSync(
            path.join(__dirname, '../../src/XChainUtxoTracker/reorg_verification.js'), 'utf8');
        const syncLoopNodeTipSrc = fs.readFileSync(
            path.join(__dirname, '../../src/XChainUtxoTracker/sync_loop_node_tip.js'), 'utf8');
        expect(lastBlocksWindowSrc, 'commitLastBlockPointerRepair not found')
            .to.match(/async commitLastBlockPointerRepair\(hash, height\)\{/);
        // A repair site is recognisable by writing lastBlockDb's hash straight
        // through the setter; both sites must call the helper instead. (The reorg
        // walk's own setLastBlockHash(lastBlock["ph"]) is a different write, inside
        // a batch it already commits, and is deliberately not matched here.)
        const src = entrySrc + lastBlocksWindowSrc + reorgVerificationSrc + syncLoopNodeTipSrc;
        const bare = src.split('\n')
            .map((line, i) => ({ line: line.trim(), n: i + 1 }))
            .filter(l => /^await this\.db\.setLastBlock(Hash|Height)\(lastBlockDb\./.test(l.line));
        expect(bare.map(l => l.n), 'a pointer-repair site is back to bare setters')
            .to.deep.equal([]);
        expect((syncLoopNodeTipSrc.match(/await this\.commitLastBlockPointerRepair\(/g) || []).length
            + (reorgVerificationSrc.match(/await this\.commitLastBlockPointerRepair\(/g) || []).length,
            'expected both repair call sites to route through the helper').to.equal(2);
    });
});
