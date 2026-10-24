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

// The store layout gate. Layout 2 keys every txid field on the whole 32-byte
// txid; a store written with 8-byte txid prefixes (no LAYOUT_VERSION stamp)
// cannot be read by this code, so startup refuses it unchanged and tells the
// operator to rebuild with bulk sync or reset it for a full rescan.

const { expect } = require('chai');
const sinon = require('sinon');
const LevelUpStore = require('../../../../src/store/level_up_db');
const { PREFIX_LAYOUT_VERSION, STORE_LAYOUT_VERSION, PREFIX_LAST_BLOCK_HEIGHT } = require('../../../../src/store/level_up_db/constants');
const { buildChain, makeNode, useSyncLoopHarness } = require('../../sync_loop/support/harness');

let counter = 0;
async function openStore() {
    const store = new LevelUpStore('store-layout-' + Date.now() + '-' + (++counter), true);
    await store.createDatabase();
    return store;
}

// A layout 1 store: an 8-byte-prefix H key, a tip pointer, no stamp.
async function seedLayout1(store) {
    await store.db.put(Buffer.concat([Buffer.from([0x48]), Buffer.alloc(8, 0xab), Buffer.alloc(4)]), Buffer.alloc(32, 1));
    await store.db.put(PREFIX_LAST_BLOCK_HEIGHT, Buffer.from((41).toString(16)));
}

async function allKeys(store) {
    const keys = [];
    for await (const key of store.db.keys()) keys.push(key.toString('latin1'));
    return keys;
}

// Opens a fresh in-memory store per case with console.warn stubbed; returns a
// handle whose .store is the case's store.
function useStore() {
    const h = { store: null };
    beforeEach(async function () {
        h.store = await openStore();
        sinon.stub(console, 'warn');
    });
    afterEach(async function () {
        sinon.restore();
        try { await h.store.close(); } catch (e) { /* closed */ }
    });
    return h;
}

describe('LevelUpDb store layout version', function () {
    const h = useStore();
    let store;
    beforeEach(function () { store = h.store; });

    it('stamps an empty store with the current layout', async function () {
        expect(await store.getLayoutVersion()).to.equal(null);
        expect(await store.ensureLayoutVersion()).to.equal('empty');
        expect((await store.db.get(PREFIX_LAYOUT_VERSION)).toString()).to.equal(String(STORE_LAYOUT_VERSION));
        expect(await store.ensureLayoutVersion()).to.equal('current');
    });

    it('leaves an empty store unstamped when asked to, for the bulk-sync loader', async function () {
        expect(await store.ensureLayoutVersion({ stamp: false })).to.equal('empty');
        expect(await allKeys(store)).to.deep.equal([]);
    });

    it('refuses an unstamped layout 1 store without changing it', async function () {
        await seedLayout1(store);
        const before = await allKeys(store);
        expect(await store.getLayoutVersion()).to.equal(1);
        let threw = null;
        try { await store.ensureLayoutVersion(); } catch (e) { threw = e; }
        expect(threw && threw.message).to.match(/8-byte txid prefixes.*indexed to block 41/);
        expect(threw.message).to.match(/Refusing to start.*bulk sync.*reset.*full rescan/);
        expect(await allKeys(store)).to.deep.equal(before);
        expect(await store.getLastBlockHeight()).to.equal(41);
    });

    it('refuses an old layout unchanged when the bulk-sync probe asks not to stamp', async function () {
        await seedLayout1(store);
        const before = await allKeys(store);
        let threw = null;
        try { await store.ensureLayoutVersion({ stamp: false }); } catch (e) { threw = e; }
        expect(threw && threw.message).to.match(/Refusing to start.*bulk sync.*reset/);
        expect(await allKeys(store)).to.deep.equal(before);
    });

});

describe('LevelUpDb store layout version: older and newer stamps', function () {
    const h = useStore();
    let store;
    beforeEach(function () { store = h.store; });

    it('refuses a store stamped with an older layout and leaves it intact', async function () {
        await seedLayout1(store);
        await store.setLayoutVersion(1);
        let threw = null;
        try { await store.ensureLayoutVersion(); } catch (e) { threw = e; }
        expect(threw && threw.message).to.match(/layout 1 .*8-byte txid prefixes/);
        expect(threw.message).to.match(/Refusing to start.*bulk sync.*reset/);
        expect(await store.getLayoutVersion()).to.equal(1);
        expect(await allKeys(store)).to.have.length(3);
    });

    it('refuses a store stamped with a newer layout and leaves it intact', async function () {
        await seedLayout1(store);
        await store.setLayoutVersion(STORE_LAYOUT_VERSION + 1);
        let threw = null;
        try { await store.ensureLayoutVersion(); } catch (e) { threw = e; }
        expect(threw && threw.message).to.match(/has layout version 3 but this tracker reads layout 2.*Refusing to start/);
        expect(await allKeys(store)).to.have.length(3);
    });

    it('refuses a stamp that does not parse', async function () {
        await store.db.put(PREFIX_LAYOUT_VERSION, Buffer.from('two'));
        let threw = null;
        try { await store.ensureLayoutVersion(); } catch (e) { threw = e; }
        expect(threw && threw.message).to.match(/unreadable layout stamp "two".*Refusing to start/);
        expect(threw.message).to.not.match(/NaN/);
    });

    // The loader writes the stamp with the tip in its last batch, so data with
    // neither is a load that stopped early, in either format; the error must
    // not claim the keys are 8-byte ones.
    it('names a stopped bulk load, not 8-byte keys, for unstamped data with no tip', async function () {
        await store.db.put(Buffer.concat([Buffer.from([0x48]), Buffer.alloc(32, 0xab), Buffer.alloc(4)]), Buffer.alloc(32, 1));
        let threw = null;
        try { await store.ensureLayoutVersion({ stamp: false }); } catch (e) { threw = e; }
        expect(threw && threw.message).to.match(/no layout stamp and no tip, which a bulk load that stopped before its final batch leaves/);
        expect(threw.message).to.not.match(/8-byte/);
        expect(threw.message).to.match(/bulk sync.*reset/);
    });
});

describe('XChainUtxoTracker sync loop: boot on an older-layout store', function () {
    const h = useSyncLoopHarness();

    it('refuses a layout 1 store before reading the node or old keys', async function () {
        const node = makeNode(buildChain(12));
        const open = LevelUpStore.prototype.createDatabase.wrappedMethod;
        LevelUpStore.prototype.createDatabase.callsFake(async function () {
            this.inMemory = true;
            const db = await open.call(this);
            if (!this.dbName.startsWith('mempool')) await seedLayout1(this);
            return db;
        });
        let threw = null;
        try { await h.run(node, () => 'stop'); } catch (e) { threw = e; }
        expect(threw && threw.message).to.match(/Refusing to start.*bulk sync.*reset/);
        expect(node.infoCalls).to.equal(0);
        expect(await h.tracker.db.getLayoutVersion()).to.equal(1);
        const legacyKey = await h.tracker.db.db.get(Buffer.concat([Buffer.from([0x48]), Buffer.alloc(8, 0xab), Buffer.alloc(4)]));
        expect(legacyKey).to.not.equal(undefined);
    });
});
