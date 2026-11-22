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

// POST /history runs a fixed number of store operations however many addresses
// it names. For watched addresses: one iterator for every address's rows (seeked
// forward from one address to the next inside it) plus the tip and tip hash
// reads. A first request adds one first-seen getMany, one tip read and one batch
// write for all its new addresses together. A per-address loop would grow these
// counts with the batch and fails here.

const sinon = require('sinon');
const { expect } = require('chai');
const supertest = require('supertest');
const {
    addressFor, txidFor, createHistoryTracker, watchComplete, commitBlock, createHistoryApp, closeTracker
} = require('./support/history_fixture');

const ADDRESS_COUNT = 20;
const STORE_OPS = ['get', 'getMany', 'iterator', 'keys', 'values', 'put', 'batch'];
const many = (offset) => Array.from({ length: ADDRESS_COUNT }, (_, i) => addressFor(offset + i));

// Three blocks, each paying every watched address once.
async function seedEveryAddress(tracker) {
    await watchComplete(tracker, many(0));
    for (let height = 1; height <= 3; height++) {
        const moves = many(0).map((address, i) => ({ address, txid: txidFor(height + ':' + i), received: 1000 + i }));
        await commitBlock(tracker, height, 1000 + height * 600, moves);
    }
}

// Store operations, by name, that one request runs.
async function countOps(tracker, addresses, limit) {
    const app = createHistoryApp(tracker);
    const spies = STORE_OPS.map((name) => sinon.spy(tracker.db.db, name));
    try {
        const res = await supertest(app).post('/history').send({ addresses, limit }).expect(200);
        const counts = {};
        STORE_OPS.forEach((name, i) => { counts[name] = spies[i].callCount; });
        return { counts, body: res.body };
    } finally {
        spies.forEach((spy) => spy.restore());
    }
}

describe('POST /history: store operations do not grow with the address count', function () {
    let tracker;
    beforeEach(async function () {
        tracker = await createHistoryTracker();
        await seedEveryAddress(tracker);
    });
    afterEach(async function () { await closeTracker(tracker); });

    it('runs the same reads for 1 watched address and for 20', async function () {
        const one = await countOps(tracker, [addressFor(0)]);
        const twenty = await countOps(tracker, many(0));
        // The reads did real work: every address's three rows came back.
        expect(one.body.transactions).to.have.length(3);
        expect(twenty.body.transactions).to.have.length(3 * ADDRESS_COUNT);
        expect(twenty.counts).to.deep.equal(one.counts);
        expect(twenty.counts).to.deep.equal({ get: 2, getMany: 0, iterator: 1, keys: 0, values: 0, put: 0, batch: 0 });
    });

    it('runs the same reads when every address stops short on a limit', async function () {
        const one = await countOps(tracker, [addressFor(0)], 1);
        const twenty = await countOps(tracker, many(0), 1);
        expect(twenty.body.cursor).to.be.a('string');
        expect(twenty.counts).to.deep.equal(one.counts);
    });

    it('watches 1 new address and 20 new addresses with the same operations', async function () {
        const one = await countOps(tracker, [addressFor(100)]);
        const twenty = await countOps(tracker, many(200));
        expect(Object.values(twenty.body.addresses).map((s) => s.history_status))
            .to.deep.equal(new Array(ADDRESS_COUNT).fill('backfilling'));
        expect(tracker.enqueued).to.have.length(1 + ADDRESS_COUNT);
        expect(twenty.counts).to.deep.equal(one.counts);
        expect(twenty.counts).to.deep.equal({ get: 3, getMany: 1, iterator: 1, keys: 0, values: 0, put: 0, batch: 1 });
    });
});
