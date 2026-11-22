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

// getbootstrap packs the database directory. A staging directory left there by an
// interrupted restore is not part of the store, so the snapshot must not carry it.
// The tar the snapshot spawns is the platform's real tar; du, pv and pigz are
// replaced by stand-ins so the suite needs none of them.

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const { expect } = require('chai');

const COMPRESSION_PATH = require.resolve('../../../src/api/compression.js');
const { STAGING_DIR_NAME } = require('../../../src/bootstrap/staged_restore.js');

function loadCompressionWithStandIns() {
    const realSpawn = childProcess.spawn;
    const hadCached = Object.prototype.hasOwnProperty.call(require.cache, COMPRESSION_PATH);
    const cached = require.cache[COMPRESSION_PATH];
    childProcess.spawn = (cmd, args, opts) => {
        if (cmd === 'du') return realSpawn('printf', ['4096\t/data/db\n']);
        if (cmd === 'pv') return realSpawn('cat');
        if (cmd === 'pigz') return realSpawn('gzip', ['-c']);
        return realSpawn(cmd, args, opts);
    };
    delete require.cache[COMPRESSION_PATH];
    try {
        return require(COMPRESSION_PATH);
    } finally {
        childProcess.spawn = realSpawn;
        delete require.cache[COMPRESSION_PATH];
        if (hadCached) require.cache[COMPRESSION_PATH] = cached;
    }
}

describe('snapshot packing', function () {
    let root;

    beforeEach(function () { root = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-staging-')); });
    afterEach(function () { fs.rmSync(root, { recursive: true, force: true }); });

    it('leaves a leftover staging directory out of the archive and keeps the store', async function () {
        const source = path.join(root, 'db');
        fs.mkdirSync(path.join(source, STAGING_DIR_NAME), { recursive: true });
        fs.writeFileSync(path.join(source, STAGING_DIR_NAME, 'partial-extract'), 'old');
        fs.writeFileSync(path.join(source, 'CURRENT'), 'MANIFEST-000001\n');
        fs.writeFileSync(path.join(source, 'MANIFEST-000001'), 'm');
        const archive = path.join(root, 'snap.tar.gz');

        const { compressDirPigz } = loadCompressionWithStandIns();
        await compressDirPigz('snapshot-task', source, archive);

        const listing = childProcess.spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' });
        expect(listing.status).to.equal(0);
        const members = listing.stdout.split('\n').filter(Boolean).map((m) => m.replace(/^\.\//, ''));
        expect(members).to.include('CURRENT').and.to.include('MANIFEST-000001');
        expect(members.filter((m) => m.startsWith(STAGING_DIR_NAME))).to.deep.equal([]);
    });
});
