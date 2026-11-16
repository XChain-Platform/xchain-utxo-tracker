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

// POST /history through the real app: entry shape and order, per-address and
// per-transaction nets, paging that never splits a transaction, the height and
// time bounds, and the batch refusals the explorer's routes also give.

const { expect } = require('chai');
const supertest = require('supertest');
const {
    addressFor, txidFor, createHistoryTracker, watchComplete, commitBlock, createHistoryApp, closeTracker
} = require('./support/history_fixture');

const A0 = addressFor(0);
const A1 = addressFor(1);
const A3 = addressFor(3);
const TX = { a: txidFor('a'), b: txidFor('b'), c: txidFor('c'), e: txidFor('e') };

// A0 is paid 5000 at 10; at 11 it pays A1 3000 and itself 1900 change (fee 100);
// at 12 A1 pays A0 2900 (fee 100). A3 alone is paid 700 at 10.
async function seedThreeBlocks(tracker) {
    await watchComplete(tracker, [A0, A1, A3]);
    await commitBlock(tracker, 10, 1000, [
        { address: A0, txid: TX.a, received: 5000 }, { address: A3, txid: TX.e, received: 700 }]);
    await commitBlock(tracker, 11, 1600, [
        { address: A0, txid: TX.b, sent: 5000 }, { address: A1, txid: TX.b, received: 3000 },
        { address: A0, txid: TX.b, received: 1900 }]);
    await commitBlock(tracker, 12, 2200, [
        { address: A1, txid: TX.c, sent: 3000 }, { address: A0, txid: TX.c, received: 2900 }]);
}

function useSeededApp() {
    const ctx = {};
    beforeEach(async function () {
        ctx.tracker = await createHistoryTracker();
        await seedThreeBlocks(ctx.tracker);
        ctx.post = (body) => supertest(createHistoryApp(ctx.tracker)).post('/history').send(body);
    });
    afterEach(async function () { await closeTracker(ctx.tracker); });
    return ctx;
}

describe('POST /history: entries', function () {
    const ctx = useSeededApp();

    it('answers one entry per transaction, newest first, with each address\'s share', async function () {
        const res = await ctx.post({ addresses: [A0, A1] }).expect(200);
        expect(res.body.transactions).to.deep.equal([
            { txid: TX.c, height: 12, time: 2200, net: '-100', addresses: {
                [A1]: { received: '0', sent: '3000', net: '-3000' },
                [A0]: { received: '2900', sent: '0', net: '2900' } } },
            { txid: TX.b, height: 11, time: 1600, net: '-100', addresses: {
                [A0]: { received: '1900', sent: '5000', net: '-3100' },
                [A1]: { received: '3000', sent: '0', net: '3000' } } },
            { txid: TX.a, height: 10, time: 1000, net: '5000', addresses: {
                [A0]: { received: '5000', sent: '0', net: '5000' } } },
        ]);
        expect(res.body.cursor).to.equal(null);
        expect(res.body.addresses).to.deep.equal({
            [A0]: { history_status: 'complete', history_from_height: 0 },
            [A1]: { history_status: 'complete', history_from_height: 0 } });
        expect(res.body.sync.tracker_height).to.equal(12);
        expect(res.headers['x-tracker-height']).to.equal('12');
    });

    it('serves amounts above 2^53 exactly and counts a repeated address once', async function () {
        await commitBlock(ctx.tracker, 13, 2800, [{ address: A3, txid: txidFor('big'), received: '1152921504606846976' }]);
        const res = await ctx.post({ addresses: [A3, A3] }).expect(200);
        expect(res.body.transactions[0].net).to.equal('1152921504606846976');
        expect(res.body.transactions[0].addresses[A3].received).to.equal('1152921504606846976');
    });

    it('answers a watched address with no history with no entries', async function () {
        await watchComplete(ctx.tracker, [addressFor(99)]);
        const res = await ctx.post({ addresses: [addressFor(99)] }).expect(200);
        expect(res.body.transactions).to.deep.equal([]);
        expect(res.body.cursor).to.equal(null);
    });
});

describe('POST /history: paging', function () {
    const ctx = useSeededApp();

    // Walks every page at `limit`, returning the pages' txid lists.
    async function walk(addresses, limit) {
        const pages = [];
        let cursor;
        for (let i = 0; i < 10; i++) {
            const body = await ctx.post({ addresses, limit, cursor }).expect(200).then((r) => r.body);
            pages.push(body.transactions);
            if (body.cursor === null) return pages;
            cursor = body.cursor;
        }
        throw new Error('paging did not end');
    }

    it('ends a page where every address has been read, so no transaction loses a share', async function () {
        const pages = await walk([A0, A1, A3], 1);
        // Page one stops at A0's first row (12); A3's row at 10 waits for the page that reaches it.
        expect(pages[0].map((t) => t.txid)).to.deep.equal([TX.c]);
        expect(pages[1].map((t) => t.txid)).to.deep.equal([TX.b]);
        expect(Object.keys(pages[1][0].addresses).sort()).to.deep.equal([A0, A1].sort());
        expect(pages[2].map((t) => t.txid).sort()).to.deep.equal([TX.a, TX.e].sort());
        expect(pages).to.have.length(3);
    });

    it('serves the same entries paged as in one read', async function () {
        const whole = await ctx.post({ addresses: [A0, A1, A3] }).expect(200).then((r) => r.body.transactions);
        const paged = (await walk([A0, A1, A3], 2)).flat();
        expect(paged).to.deep.equal(whole);
    });

    it('refuses a cursor it did not issue', async function () {
        const res = await ctx.post({ addresses: [A0], cursor: '12:zz' }).expect(400);
        expect(res.body.code).to.equal('INVALID_CURSOR');
    });
});

describe('POST /history: bounds', function () {
    const ctx = useSeededApp();
    const heights = (body) => body.transactions.map((t) => t.height);

    it('bounds by height and by block time, both inclusive', async function () {
        expect(heights((await ctx.post({ addresses: [A0], from_height: 11 })).body)).to.deep.equal([12, 11]);
        expect(heights((await ctx.post({ addresses: [A0], to_height: 11 })).body)).to.deep.equal([11, 10]);
        expect(heights((await ctx.post({ addresses: [A0], from_time: 1600, to_time: 1600 })).body)).to.deep.equal([11]);
        expect(heights((await ctx.post({ addresses: [A0], from_time: 1601 })).body)).to.deep.equal([12]);
    });

    it('refuses a from_ bound above its to_ bound', async function () {
        const res = await ctx.post({ addresses: [A0], from_height: 12, to_height: 11 }).expect(400);
        expect(res.body.code).to.equal('BAD_REQUEST');
    });
});

describe('POST /history: scan ceiling', function () {
    const ctx = useSeededApp();

    it('stops a filtered scan at its ceiling with a cursor, and the next page finishes it', async function () {
        const many = addressFor(50);
        await watchComplete(ctx.tracker, [many]);
        const old = Array.from({ length: 2600 }, (_, i) => ({ address: many, txid: txidFor('old' + i), received: 1 }));
        await commitBlock(ctx.tracker, 20, 1000, old);
        await commitBlock(ctx.tracker, 21, 9000, [{ address: many, txid: txidFor('new'), received: 5 }]);
        const first = (await ctx.post({ addresses: [many], from_time: 5000 }).expect(200)).body;
        expect(first.transactions.map((t) => t.txid)).to.deep.equal([txidFor('new')]);
        expect(first.cursor).to.match(/^20:[0-9a-f]{64}$/);
        const second = (await ctx.post({ addresses: [many], from_time: 5000, cursor: first.cursor }).expect(200)).body;
        expect(second.transactions).to.deep.equal([]);
        expect(second.cursor).to.equal(null);
    });
});

describe('POST /history: refusals', function () {
    const ctx = useSeededApp();

    it('refuses more than twenty addresses, counted before duplicates collapse', async function () {
        const res = await ctx.post({ addresses: new Array(21).fill(A0) }).expect(400);
        expect(res.body.code).to.equal('TOO_MANY_ADDRESSES');
    });

    it('refuses a missing, empty or non-string address list', async function () {
        for (const body of [{}, { addresses: [] }, { addresses: [A0, 7] }]) {
            expect((await ctx.post(body).expect(400)).body.code).to.equal('INVALID_ADDRESSES');
        }
    });

    it('refuses the whole batch for one malformed address, naming it', async function () {
        const res = await ctx.post({ addresses: [A0, 'not-an-address'] }).expect(400);
        expect(res.body).to.deep.equal({ error: 'Invalid address: not-an-address', code: 'INVALID_ADDRESS' });
    });

    it('refuses a non-integer limit', async function () {
        expect((await ctx.post({ addresses: [A0], limit: 1.5 }).expect(400)).body.code).to.equal('BAD_REQUEST');
    });
});
