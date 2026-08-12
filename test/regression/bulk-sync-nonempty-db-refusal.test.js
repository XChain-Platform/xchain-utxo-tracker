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

// ─── Regression (): the bulk loader must refuse a non-empty store ────
//
// loadKeys only ever `put`s and never deletes a key the incoming seed no longer
// carries, and it writes the LAST_* markers LAST. api.js gates the whole
// pipeline on isDbEmpty(), which reads LAST_BLOCK_HEIGHT rather than counting
// keys - so a load that crashed after some prefixes committed but before the
// markers looks "empty" on the next boot, gets reseeded on top of its own
// partial write, and the marker write then advertises the mixture as fully
// synced. Old B/O/H/S/W/Z records that no longer exist in the seed are served as
// live UTXOs. The loader now probes for one key and refuses.

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { expect } = require('chai');
const { ClassicLevel } = require('classic-level');

const { loadKeys } = require('../../src/bulk-sync/merger/loader.js');

describe('Regression (#4387): bulk loader refuses a populated target DB', function () {
    this.timeout(30000);

    let tmp;
    beforeEach(function () { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bulk-nonempty-')); });
    afterEach(function () { fs.rmSync(tmp, { recursive: true, force: true }); });

    // Seed one record of the shape a crashed load leaves behind: a data key with
    // no LAST_* markers, which is precisely what isDbEmpty() reads as empty.
    async function seedMarkerlessResidue(dbPath) {
        const db = new ClassicLevel(dbPath, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
        await db.open();
        await db.put(Buffer.from('B-stale-from-a-crashed-load'), Buffer.from('stale'));
        await db.close();
    }

    it('rejects when the target DB already holds a key, before reading any prefix file', async function () {
        const dbPath  = path.join(tmp, 'db');
        const keysDir = path.join(tmp, 'keys');
        fs.mkdirSync(keysDir, { recursive: true });
        await seedMarkerlessResidue(dbPath);

        let thrown = null;
        try { await loadKeys({ keysDir, dbPath, removeSpent: true }); }
        catch (err) { thrown = err; }

        expect(thrown, 'seeding a populated store must reject').to.be.an('error');
        expect(thrown.message).to.match(/is not empty/);
        expect(thrown.message).to.include(dbPath);
    });

    // Ordering proof: with the SAME empty keysDir an empty DB fails on the missing
    // prefix file instead. Without this, the assertion above could be satisfied by
    // any error at all and would not show the emptiness guard is what fired.
    it('an empty DB with the same keysDir fails later, on the missing prefix file', async function () {
        const dbPath  = path.join(tmp, 'db-empty');
        const keysDir = path.join(tmp, 'keys');
        fs.mkdirSync(keysDir, { recursive: true });

        let thrown = null;
        try { await loadKeys({ keysDir, dbPath, removeSpent: true }); }
        catch (err) { thrown = err; }

        expect(thrown).to.be.an('error');
        expect(thrown.message).to.match(/missing B\.dat/);
        expect(thrown.message).to.not.match(/is not empty/);
    });

    // The guard must not fire on a directory LevelDB merely created: an empty
    // store is the normal, required starting state for every real load.
    it('accepts a freshly created, keyless store', async function () {
        const dbPath  = path.join(tmp, 'db-fresh');
        const keysDir = path.join(tmp, 'keys');
        fs.mkdirSync(keysDir, { recursive: true });

        const db = new ClassicLevel(dbPath, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
        await db.open();
        await db.close();

        let thrown = null;
        try { await loadKeys({ keysDir, dbPath, removeSpent: true }); }
        catch (err) { thrown = err; }

        // Still fails (the fixture carries no prefix files) but NOT on emptiness.
        expect(thrown).to.be.an('error');
        expect(thrown.message).to.match(/missing B\.dat/);
    });
});
