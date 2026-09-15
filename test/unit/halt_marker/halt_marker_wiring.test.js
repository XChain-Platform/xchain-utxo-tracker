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

const trackerSrc = fs.readFileSync(path.join(__dirname, '../../../src/XChainUtxoTracker.js'), 'utf8');
const apiSrc = fs.readFileSync(path.join(__dirname, '../../../src/api.js'), 'utf8');

describe('halt marker: boot and launch wiring', function () {
    it('start() reads the marker before the sync loop and returns into the halted state', function () {
        const start = trackerSrc.slice(trackerSrc.indexOf('    async start(){'));
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
        expect(trackerSrc).to.match(/P_PENDING_CLEANUP_KEY = Buffer\.from\(\[0x50\]\)/);
        expect(trackerSrc).to.match(/Q_UNDO_WATERMARK_KEY = Buffer\.from\(\[0x51\]\)/);
    });
});

describe('halt marker: status surfaces', function () {
    it('halted_at and halted_height ride every halt surface', function () {
        const status = apiSrc.slice(apiSrc.indexOf("app.get('/status'"));
        expect(status).to.match(/halted_at: tracker\.haltedAt/);
        expect(status).to.match(/halted_height: tracker\.haltedHeight/);
        const sync = apiSrc.slice(apiSrc.indexOf('async get_sync_status()'), apiSrc.indexOf('async health()'));
        expect(sync).to.match(/result\.halted_at\s*=\s*tracker\.haltedAt/);
        expect(sync).to.match(/result\.halted_height\s*=\s*tracker\.haltedHeight/);
        const meta = apiSrc.slice(apiSrc.indexOf('async function getFreshnessMeta('));
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
