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

// ─── Regression: cleanupAgedBlocks prunes the Z block->script reverse index ──
//
// The Z index ('Z'/0x5A, one record per block + first-seen script) has exactly
// one reader: the reorg unwind (removeOutputScriptsInBlock), which is hard
// depth-guarded to the undoBlocks window. A Z record for a block older than
// that window is therefore permanently unreachable, yet the TP-19 aged-block
// prune originally removed only its W twin, so Z grew monotonically with every
// distinct scriptPubKey ever seen for the life of the store. cleanupAgedBlocks
// must prune Z alongside W while leaving the S first-seen record intact (S
// backs the live getFirstSeen query).

const { expect } = require('chai');
const crypto = require('crypto');
const LevelUpStore = require('../../src/LevelUpDb');
const XChainUtxoTracker = require('../../src/XChainUtxoTracker');

function randHash() { return crypto.randomBytes(32).toString('hex'); }
function randBuf32() { return crypto.randomBytes(32); }
function makeDb() { return new LevelUpStore('z-prune-' + Date.now() + '-' + Math.random(), true); }

describe('Regression: cleanupAgedBlocks prunes the Z reverse index (S survives)', function () {
    let tracker, db;

    beforeEach(async function () {
        LevelUpStore.knownScripts = new Set();
        tracker = new XChainUtxoTracker('bitcoin-regtest', '127.0.0.1', '18443', 'u', 'p', 'z-prune-db', false);
        db = makeDb(); await db.createDatabase();
        tracker.db = db;
    });
    afterEach(async function () {
        try { await db.close(); } catch (e) {}
        LevelUpStore.knownScripts = new Set();
    });

    it('aged-out block loses its Z records; S first-seen and live-window Z survive', async function () {
        const agedHash = randHash();
        const liveHash = randHash();
        const agedScript = randBuf32();
        const liveScript = randBuf32();

        await db.beginTransaction();
        await db.addLastStoredBlock(agedHash);
        await db.addLastStoredBlock(liveHash);
        await db.insertOutputScriptBlock(agedScript, agedHash, 100);
        await db.insertOutputScriptBlock(liveScript, liveHash, 101);
        await db.endTransaction(true);

        expect(await db.getValuesFromKeyPattern('5a' + agedHash)).to.have.length(1);
        expect(await db.getValuesFromKeyPattern('5a' + liveHash)).to.have.length(1);

        // agedHash has aged out of the reorg window; liveHash is still live.
        tracker.lastBlocks = [liveHash];
        tracker.pendingKMCleanup = [agedHash];

        await tracker.cleanupAgedBlocks();

        // Aged block's Z records are pruned, the live block's are untouched.
        expect(await db.getValuesFromKeyPattern('5a' + agedHash)).to.be.empty;
        expect(await db.getValuesFromKeyPattern('5a' + liveHash)).to.have.length(1);

        // Both S first-seen records survive: they back the live getFirstSeen
        // query and must be retained for the life of the store.
        expect(await db.getOutputScriptBlock(agedScript.toString('hex'))).to.deep.equal({ h: 100 });
        expect(await db.getOutputScriptBlock(liveScript.toString('hex'))).to.deep.equal({ h: 101 });
    });
});
