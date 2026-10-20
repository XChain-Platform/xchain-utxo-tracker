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

// Wiring guards for the persisted halt marker. start() opens a real on-disk
// store and api.js's status routes live inside startApi()'s closure, so neither
// is reachable from a require; these read the source so an unwired boot check
// or a status field dropped from one surface cannot leave the behaviour tests
// green.

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');
const XChainUtxoTracker = require('../../../src/XChainUtxoTracker');
const LevelUpStore = require('../../../src/store/level_up_db');

const syncLoopSrc = fs.readFileSync(path.join(__dirname, '../../../src/XChainUtxoTracker/sync_loop.js'), 'utf8');
const constantsSrc = fs.readFileSync(path.join(__dirname, '../../../src/XChainUtxoTracker/constants.js'), 'utf8');
const apiSrc = fs.readFileSync(path.join(__dirname, '../../../src/api.js'), 'utf8');
const startupSrc = fs.readFileSync(path.join(__dirname, '../../../src/api/startup.js'), 'utf8');
const syncStatusSrc = fs.readFileSync(path.join(__dirname, '../../../src/api/sync_status.js'), 'utf8');

describe('halt marker: boot and launch wiring', function () {
    it('start() reads the marker before the sync loop and returns into the halted state', function () {
        const start = syncLoopSrc.slice(syncLoopSrc.indexOf('    async start(){'));
        const resumeAt = start.indexOf('if (await this.resumeHaltFromMarker()) return');
        const loopAt = start.indexOf('while (true){');
        expect(resumeAt, 'the boot check is wired').to.be.greaterThan(-1);
        expect(loopAt).to.be.greaterThan(resumeAt);
        expect(start.indexOf('logger.info("Indexing...")')).to.be.greaterThan(resumeAt);
    });

    it('the launch guard awaits the marker write before it settles', function () {
        const launch = apiSrc.slice(apiSrc.indexOf('function launchTracker(tracker)'));
        expect(launch).to.match(/await tracker\.haltForResync\(/);
    });

    it('the marker key is the reserved R byte, apart from every other single-byte record', function () {
        expect(LevelUpStore.HALT_MARKER_KEY).to.deep.equal(Buffer.from([0x52]));
        expect(constantsSrc).to.match(/P_PENDING_CLEANUP_KEY = Buffer\.from\(\[0x50\]\)/);
        expect(constantsSrc).to.match(/Q_UNDO_WATERMARK_KEY = Buffer\.from\(\[0x51\]\)/);
    });
});

describe('halt marker: status surfaces', function () {
    it('halted_at and halted_height ride every halt surface', function () {
        const status = syncStatusSrc.slice(syncStatusSrc.indexOf("app.get('/status'"));
        expect(status).to.match(/halted_at: tracker\.haltedAt/);
        expect(status).to.match(/halted_height: tracker\.haltedHeight/);
        const sync = syncStatusSrc.slice(syncStatusSrc.indexOf('async function get_sync_status('));
        expect(sync).to.match(/result\.halted_at\s*=\s*tracker\.haltedAt/);
        expect(sync).to.match(/result\.halted_height\s*=\s*tracker\.haltedHeight/);
        const meta = startupSrc.slice(startupSrc.indexOf('async function getFreshnessMeta('));
        expect(meta).to.match(/haltedAt:\s*tracker\.haltedAt/);
        expect(meta).to.match(/haltedHeight:\s*tracker\.haltedHeight/);
    });

    it('computeFreshness carries them only while halted', function () {
        const running = XChainUtxoTracker.computeFreshness(10, 10, true, { mempoolReconverged: true });
        expect(running).to.not.have.property('halted_at');
        expect(running).to.not.have.property('halted_height');
        const halted = XChainUtxoTracker.computeFreshness(10, 10, true, {
            halted: true, haltReason: 'r', haltedAt: '2026-09-15T00:00:00.000Z', haltedHeight: 9
        });
        expect(halted.halted_at).to.equal('2026-09-15T00:00:00.000Z');
        expect(halted.halted_height).to.equal(9);
    });
});

// A halt freezes the store, so the per-response sibling (get_utxos `sync`, REST
// X-Synced and X-Mempool-Ready) must floor it exactly as get_sync_status does,
// even while the raw latches still read true.
describe('Halt marker wiring: halt floors both freshness surfaces alike', function () {
    const { get_sync_status } = require('../../../src/api/sync_status.js');

    function haltedTrackerWithLiveLatches() {
        return {
            db: { getLastBlockHeight: async () => 10 },
            connector: { getBlockchainInfo: async () => ({ blocks: 10 }) },
            latestKnownChainTip: 10,
            lastNodeRpcOkAt: Date.now(),
            isSynced: () => true,
            isMempoolReconverged: () => true,
            halted: true, haltReason: 'r', haltedAt: '2026-09-15T00:00:00.000Z', haltedHeight: 9,
            reorgCount: 0, lastReorgDepth: 0
        };
    }

    it('reports a halted tracker unsynced and not mempool ready on the per-response sibling', function () {
        const halted = XChainUtxoTracker.computeFreshness(10, 10, true, {
            mempoolReconverged: true, halted: true, haltReason: 'r'
        });
        expect(halted).to.include({ synced: false, mempool_ready: false, halted: true, halt_reason: 'r' });
        const running = XChainUtxoTracker.computeFreshness(10, 10, true, { mempoolReconverged: true });
        expect(running).to.include({ synced: true, mempool_ready: true });
    });

    it('agrees with get_sync_status on synced and mempool_ready for the same halted tracker', async function () {
        const tracker = haltedTrackerWithLiveLatches();
        const status = await get_sync_status(tracker);
        // The arguments getFreshnessMeta (src/api/startup.js) passes.
        const sibling = XChainUtxoTracker.computeFreshness(10, tracker.latestKnownChainTip, tracker.isSynced(), {
            mempoolReconverged: tracker.isMempoolReconverged(), halted: !!tracker.halted,
            haltReason: tracker.haltReason, haltedAt: tracker.haltedAt, haltedHeight: tracker.haltedHeight
        });
        expect(status).to.include({ synced: false, mempool_ready: false });
        expect({ synced: sibling.synced, mempool_ready: sibling.mempool_ready })
            .to.deep.equal({ synced: status.synced, mempool_ready: status.mempool_ready });
    });
});
