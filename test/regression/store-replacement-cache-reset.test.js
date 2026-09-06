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

// Regression: opening a store clears the process-global caches that describe it.
//
// restorebootstrap wipes /data, extracts an OLDER snapshot and calls
// launchTracker(tracker) -> XChainUtxoTracker.start() in the SAME process, which
// builds brand-new LevelUpStore objects over a different database. The statics
// LevelUpStore.knownScripts and LevelUpStore.outputCache are process-global, so
// without a reset at open they still describe the REPLACED database: a script
// first seen after the snapshot stays in knownScripts, insertOutputScriptBlock
// Tier-0 hits on it during replay and never rewrites its S/Z records, and
// getFirstSeen serves null for that script forever.

const { expect } = require('chai');
const crypto = require('crypto');
const LevelUpStore = require('../../src/LevelUpDb');

function randHash() { return crypto.randomBytes(32).toString('hex'); }
function randHash8() { return crypto.randomBytes(8).toString('hex'); }
function makeStore() { return new LevelUpStore('replace-' + Date.now() + '-' + Math.random(), true); }

describe('store replacement resets the DB-derived caches', function () {

  afterEach(function () { LevelUpStore.resetCaches(); });

  it('createDatabase() opens with both caches cold', async function () {
    // Seed both statics so a missing reset is visible rather than vacuously green.
    LevelUpStore.knownScripts.add(randHash());
    LevelUpStore.outputCache.set('stale-key', Buffer.alloc(4));
    expect(LevelUpStore.knownScripts.size, 'seeded').to.be.greaterThan(0);
    expect(LevelUpStore.outputCache.size, 'seeded').to.be.greaterThan(0);

    const store = makeStore();
    await store.createDatabase();
    try {
      expect(LevelUpStore.knownScripts.size, 'knownScripts cold at open').to.equal(0);
      expect(LevelUpStore.outputCache.size, 'outputCache cold at open').to.equal(0);
    } finally {
      try { await store.close(); } catch (e) {}
    }
  });

  it('a script cached against the OLD store is re-recorded in the replacement store', async function () {
    const script = randHash();

    // Store 1 stands in for the pre-restore database: the script is first seen at 200.
    const first = makeStore();
    await first.createDatabase();
    await first.beginTransaction();
    await first.insertOutputScriptBlock(script, randHash(), 200);
    await first.endTransaction(true);
    expect((await first.getOutputScriptBlock(script)).h).to.equal(200);
    expect(LevelUpStore.knownScripts.has(script), 'cached against store 1').to.equal(true);
    await first.close();

    // Store 2 stands in for the restored (older) database, opened in the same process
    // with the cache still warm. Replay re-mines the script at its real height 100.
    const second = makeStore();
    await second.createDatabase();
    await second.beginTransaction();
    await second.insertOutputScriptBlock(script, randHash(), 100);
    await second.endTransaction(true);

    const record = await second.getOutputScriptBlock(script);
    try {
      expect(record, 'the S first-seen record must exist in the replacement store').to.not.equal(null);
      expect(record.h, 'replay must write the replayed height, not inherit the old cache')
        .to.equal(100);
    } finally {
      try { await second.close(); } catch (e) {}
    }
  });
});
