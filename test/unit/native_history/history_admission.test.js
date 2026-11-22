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

// Who joins the history watch list: a first request watches an address and
// queues exactly one backfill from its first-seen height; the watch-list
// ceiling, the per-IP budget and the per-address cooldown refuse the rest; and
// the backfill runner keeps to its concurrency cap.

const { expect } = require('chai');
const supertest = require('supertest');
const HistoryBackfill = require('../../../src/native_history/backfill');
const { until } = require('./support/chain_history');
const {
    addressFor, scriptHashFor, blockHashFor, createHistoryTracker, commitBlock, createHistoryApp, closeTracker
} = require('./support/history_fixture');

const hexOf = (address) => scriptHashFor(address).toString('hex');

function useTracker(options) {
    const ctx = { clock: 1000000 };
    beforeEach(async function () {
        ctx.tracker = await createHistoryTracker({ now: () => ctx.clock, ...options });
        await commitBlock(ctx.tracker, 5, 100, []);
        ctx.post = (addresses) => supertest(createHistoryApp(ctx.tracker)).post('/history').send({ addresses });
        ctx.ask = (addresses, ip) => ctx.tracker.getNativeHistory(addresses, { limit: 10 }, { ip });
        ctx.status = (read, address) => read.addressStatus[address];
    });
    afterEach(async function () { await closeTracker(ctx.tracker); });
    return ctx;
}

describe('POST /history: a first request', function () {
    const ctx = useTracker({});

    it('watches the address, answers backfilling and queues one backfill however often it is asked', async function () {
        const address = addressFor(300);
        const first = await ctx.post([address]).expect(200);
        await ctx.post([address]).expect(200);
        await Promise.all([ctx.post([address]), ctx.post([address])]);
        expect(first.body.addresses[address]).to.deep.equal({ history_status: 'backfilling', history_from_height: null });
        expect(ctx.tracker.enqueued).to.deep.equal([hexOf(address)]);
        // Never seen by the tracker: its past can only start after the tip it joined at.
        const record = (await ctx.tracker.db.getHistoryWatchRecords()).get(hexOf(address));
        expect(record).to.deep.equal({ start: 6, liveFrom: null, progress: { next: 6, done: false, open: [] } });
    });

    it('starts the backfill at the address\'s first-seen height', async function () {
        const address = addressFor(301);
        await ctx.tracker.db.beginTransaction();
        await ctx.tracker.db.insertOutputScriptBlock(scriptHashFor(address), blockHashFor(3), 3);
        await ctx.tracker.db.endTransaction();
        await ctx.post([address]).expect(200);
        expect((await ctx.tracker.db.getHistoryWatchRecords()).get(hexOf(address)).start).to.equal(3);
    });

    it('answers 503 and watches nothing before the tracker has indexed a block', async function () {
        const empty = await createHistoryTracker();
        try {
            const res = await supertest(createHistoryApp(empty)).post('/history').send({ addresses: [addressFor(302)] }).expect(503);
            expect(res.body.code).to.equal('NOT_READY');
            expect((await empty.db.getHistoryWatchRecords()).size).to.equal(0);
        } finally {
            await closeTracker(empty);
        }
    });
});

describe('POST /history: the watch-list ceiling', function () {
    const ctx = useTracker({ watchMax: 2 });

    it('refuses new addresses once the list is full and stores nothing for them', async function () {
        const [a, b, c] = [addressFor(310), addressFor(311), addressFor(312)];
        const res = await ctx.post([a, b, c]).expect(200);
        expect(res.body.addresses[c]).to.deep.equal({ history_status: 'not_watched', history_from_height: null, history_refused: 'WATCH_LIST_FULL' });
        expect(res.body.addresses[a].history_status).to.equal('backfilling');
        expect(ctx.tracker.enqueued).to.deep.equal([hexOf(a), hexOf(b)]);
        expect([...(await ctx.tracker.db.getHistoryWatchRecords()).keys()].sort()).to.deep.equal([hexOf(a), hexOf(b)].sort());
    });
});

describe('POST /history: the per-IP budget and the per-address cooldown', function () {
    const ctx = useTracker({ perIp: 2, cooldownMs: 60000 });

    it('charges new addresses to the source IP and refuses past its budget', async function () {
        const res = await ctx.post([addressFor(320), addressFor(321), addressFor(322)]).expect(200);
        expect(res.body.addresses[addressFor(322)].history_refused).to.equal('IP_BUDGET');
        expect(ctx.status(await ctx.ask([addressFor(323)], '10.0.0.2'), addressFor(323)).history_status).to.equal('backfilling');
    });

    it('charges an address once, however often a watched address is asked for', async function () {
        for (let i = 0; i < 5; i++) await ctx.ask([addressFor(330)], '10.0.0.3');
        expect(ctx.status(await ctx.ask([addressFor(331)], '10.0.0.3'), addressFor(331)).history_status).to.equal('backfilling');
    });

    it('cools an over-budget address for that IP only, so another caller can still watch it', async function () {
        const target = addressFor(342);
        await ctx.ask([addressFor(340), addressFor(341), target], '10.0.0.4');
        expect(ctx.status(await ctx.ask([target], '10.0.0.4'), target).history_refused).to.equal('COOLDOWN');
        ctx.clock += 60001;
        expect(ctx.status(await ctx.ask([target], '10.0.0.4'), target).history_refused).to.equal('IP_BUDGET');
        expect(ctx.status(await ctx.ask([target], '10.0.0.5'), target).history_status).to.equal('backfilling');
    });
});

describe('POST /history: the cooldown after a full watch list', function () {
    const ctx = useTracker({ watchMax: 1, cooldownMs: 60000 });

    it('refuses the address to every caller until its cooldown ends', async function () {
        const [kept, target] = [addressFor(350), addressFor(351)];
        await ctx.ask([kept, target], '10.0.0.6');
        expect(ctx.status(await ctx.ask([target], '10.0.0.7'), target).history_refused).to.equal('COOLDOWN');
        ctx.clock += 60001;
        expect(ctx.status(await ctx.ask([target], '10.0.0.7'), target).history_refused).to.equal('WATCH_LIST_FULL');
    });
});

describe('native history backfill: concurrency cap', function () {
    it('never runs more passes at once than the cap, and groups queued addresses into one pass', async function () {
        const runner = new HistoryBackfill({}, {}, { concurrency: 1, passMax: 20 });
        let active = 0;
        let peak = 0;
        const groups = [];
        runner.runPass = async (hexes) => {
            groups.push(hexes);
            active++;
            peak = Math.max(peak, active);
            await new Promise((resolve) => setTimeout(resolve, 10));
            active--;
        };
        runner.enqueue('a');
        runner.enqueueMany(['b', 'c', 'd']);
        await until(() => groups.length === 2 && active === 0);
        expect(peak).to.equal(1);
        expect(groups).to.deep.equal([['a'], ['b', 'c', 'd']]);
        expect(runner.enqueue('a')).to.equal(true);
        await runner.stop();
    });
});
