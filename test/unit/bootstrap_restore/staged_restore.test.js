/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************/

'use strict';

// Drives the real decompressPigz (validation, extraction, layout gate, wipe,
// promote) against real classic-level stores. Only the pigz and pv binaries are
// replaced by pass-through shims so the suite does not depend on them being
// installed; tar and the store itself are real.

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createHash } = require('crypto');
const { ClassicLevel } = require('classic-level');

require('../../../src/api.js');
const { decompressPigz, tasks } = require('../../../src/api/compression.js');
const { handleRestoreFailure } = require('../../../src/bootstrap/bootstrap_recovery.js');
const { getLayoutVersion } = require('../../../src/store/level_up_db/store_layout.js');
const { STAGING_DIR_NAME } = require('../../../src/bootstrap/staged_restore.js');

const KEY_OPTS = { keyEncoding: 'buffer', valueEncoding: 'buffer' };

// A store with a tip, so an unstamped one reads as layout 1; `layout` null leaves
// the stamp out, `empty` leaves the whole store without keys.
async function buildStore(dir, { layout, empty = false, leftover = false }) {
    const db = new ClassicLevel(dir, KEY_OPTS);
    await db.open();
    if (!empty) {
        await db.put(Buffer.from('LAST_BLOCK_HEIGHT'), Buffer.from('a'));
        await db.put(Buffer.from('some-key'), Buffer.from('some-value'));
        if (layout !== null) await db.put(Buffer.from('LAYOUT_VERSION'), Buffer.from(String(layout)));
    }
    await db.close();
    if (leftover) {
        fs.mkdirSync(path.join(dir, STAGING_DIR_NAME));
        fs.writeFileSync(path.join(dir, STAGING_DIR_NAME, "partial-extract"), "old");
    }
    return dir;
}

function archiveOf(storeDir, archive) {
    const r = spawnSync('tar', ['-czf', archive, '-C', storeDir, '.']);
    if (r.status !== 0) throw new Error('tar failed building the archive fixture');
    const digest = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    fs.writeFileSync(archive + '.sha256', `${digest}  ${path.basename(archive)}\n`);
    return archive;
}

async function layoutOf(dir) {
    const db = new ClassicLevel(dir, { ...KEY_OPTS, createIfMissing: false });
    await db.open();
    try { return await getLayoutVersion.call({ db }); } finally { await db.close(); }
}

let root, live, savedPath;

function useStagedRestoreFixture() {
    beforeEach(function () {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-staged-restore-'));
        const shims = path.join(root, 'shims');
        fs.mkdirSync(shims);
        fs.writeFileSync(path.join(shims, 'pigz'), '#!/bin/sh\nexec gzip "$@"\n', { mode: 0o755 });
        fs.writeFileSync(path.join(shims, 'pv'), '#!/bin/sh\nexec cat\n', { mode: 0o755 });
        savedPath = process.env.PATH;
        process.env.PATH = `${shims}${path.delimiter}${savedPath}`;
        process.env.BOOTSTRAP_RESTORE_ALLOW_UNSIGNED = '1';
        live = path.join(root, 'live');
        fs.mkdirSync(live);
        fs.writeFileSync(path.join(live, 'LIVE_STORE_MARKER'), 'keep me');
    });

    afterEach(function () {
        process.env.PATH = savedPath;
        delete process.env.BOOTSTRAP_RESTORE_ALLOW_UNSIGNED;
        fs.rmSync(root, { recursive: true, force: true });
    });
}

async function restoreFrom(opts) {
    const archive = archiveOf(await buildStore(path.join(root, 'src-store'), opts), path.join(root, 'bootstrap.tar.gz'));
    const taskId = `staged-${Date.now()}-${Math.random()}`;
    tasks[taskId] = { progress: 0, filename: 'bootstrap.tar.gz' };
    try { await decompressPigz(taskId, archive, live); return { taskId }; }
    catch (error) { return { taskId, error }; }
}

describe('staged restore', function () {
    useStagedRestoreFixture();

    it('replaces the live store with a layout 2 archive and leaves no staging directory', async function () {
        const { error } = await restoreFrom({ layout: 2 });
        expect(error).to.equal(undefined);
        expect(fs.existsSync(path.join(live, 'LIVE_STORE_MARKER'))).to.equal(false);
        expect(fs.existsSync(path.join(live, STAGING_DIR_NAME))).to.equal(false);
        expect(await layoutOf(live)).to.equal(2);
    });

    it('refuses a layout 1 archive before the wipe and keeps the live store', async function () {
        const { error, taskId } = await restoreFrom({ layout: null });
        expect(error, 'expected the layout 1 archive to be refused').to.be.instanceOf(Error);
        expect(error.message).to.match(/layout 1 but this tracker reads layout 2/);
        expect(error.preWipe).to.equal(true);
        expect(fs.readFileSync(path.join(live, 'LIVE_STORE_MARKER'), 'utf8')).to.equal('keep me');
        expect(fs.existsSync(path.join(live, STAGING_DIR_NAME))).to.equal(false);
        expect(fs.existsSync(path.join(live, 'CURRENT'))).to.equal(false);

        let relaunched = 0, failedLoud = 0;
        handleRestoreFailure({ tasks, taskId, error, failLoud: () => { failedLoud++; }, relaunch: () => { relaunched++; }, log: () => {} });
        expect(tasks[taskId].progress).to.equal(-1);
        expect([relaunched, failedLoud]).to.deep.equal([1, 0]);
    });
});

describe('staged restore', function () {
    useStagedRestoreFixture();

    it('refuses an archive from a newer layout than this tracker reads', async function () {
        const { error } = await restoreFrom({ layout: 3 });
        expect(error).to.be.instanceOf(Error);
        expect(error.message).to.match(/layout 3 but this tracker reads layout 2/);
        expect(fs.existsSync(path.join(live, 'LIVE_STORE_MARKER'))).to.equal(true);
    });

    it('refuses an archive whose store holds no data', async function () {
        const { error } = await restoreFrom({ layout: 2, empty: true });
        expect(error).to.be.instanceOf(Error);
        expect(error.message).to.match(/store with no data/);
        expect(error.preWipe).to.equal(true);
        expect(fs.existsSync(path.join(live, 'LIVE_STORE_MARKER'))).to.equal(true);
    });

    it('discards a staging directory left by an interrupted restore', async function () {
        const stale = path.join(live, STAGING_DIR_NAME);
        fs.mkdirSync(stale);
        fs.writeFileSync(path.join(stale, 'stale-file'), 'old');
        const { error } = await restoreFrom({ layout: 2 });
        expect(error).to.equal(undefined);
        expect(fs.existsSync(path.join(live, STAGING_DIR_NAME))).to.equal(false);
        expect(fs.existsSync(path.join(live, 'stale-file'))).to.equal(false);
    });
});

describe('staged restore', function () {
    useStagedRestoreFixture();

    it('restores an archive that carries a leftover staging directory in its root', async function () {
        const { error } = await restoreFrom({ layout: 2, leftover: true });
        expect(error, error && error.message).to.equal(undefined);
        expect(fs.existsSync(path.join(live, 'LIVE_STORE_MARKER'))).to.equal(false);
        expect(fs.existsSync(path.join(live, STAGING_DIR_NAME))).to.equal(false);
        expect(await layoutOf(live)).to.equal(2);
    });
});
