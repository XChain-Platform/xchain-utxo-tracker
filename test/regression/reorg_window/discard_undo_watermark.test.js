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

// The undo-window watermark is staged into the open batch beside the block's N
// record, and the in-memory mark moves at stage time. A discarded batch takes the
// staged Q record with it, so the mark in memory must go back to what disk holds;
// otherwise status and the rollback budget read blocks as spent that never were,
// and the refilling window never rewrites Q because memory says it already did.

const { expect } = require('chai');
const { Q_UNDO_WATERMARK_KEY } = require('../../../src/XChainUtxoTracker/constants');
const {
    createTestTracker,
    closeTracker,
    processBlock,
    processBlocksAndCommit,
    buildCoinbaseChain
} = require('../../integration/support/helpers');

let tracker;

async function storedWatermark() {
    const raw = await tracker.db.db.get(Q_UNDO_WATERMARK_KEY);
    return raw === undefined ? null : parseInt(raw.toString(), 10);
}

// Five blocks committed, three more staged into an open batch, then the batch discarded.
async function stageThreeThenDiscard(blocks) {
    await processBlocksAndCommit(tracker, blocks.slice(0, 5));
    expect(tracker.undoWindowWatermark).to.equal(5);
    expect(await storedWatermark()).to.equal(5);

    await tracker.db.beginTransaction();
    for (const block of blocks.slice(5, 8)) await processBlock(tracker, block);
    expect(tracker.undoWindowWatermark, 'the staged blocks count in memory').to.equal(8);

    await tracker.discardInflightBatchForReorg(3);
}

function useTracker(suite) {
    suite.timeout(0);
    beforeEach(async function () {
        tracker = await createTestTracker();
        tracker.undoBlocks = 12;
        tracker.sleep = async () => {};
    });
    afterEach(async function () {
        await closeTracker(tracker);
    });
}

describe('Regression: a discarded batch and the undo-window watermark', function () {
    useTracker(this);

    it('returns the in-memory mark to the committed one when the batch is discarded', async function () {
        await stageThreeThenDiscard(buildCoinbaseChain(8, 0, 0));
        expect(tracker.lastBlocks).to.have.length(5);
        expect(tracker.undoWindowWatermark).to.equal(5);
        expect(tracker.undoWindowWatermarkPersisted).to.equal(5);
        expect(await storedWatermark()).to.equal(5);
    });

    it('rewrites Q when the window refills past the discarded depth', async function () {
        const blocks = buildCoinbaseChain(8, 0, 0);
        await stageThreeThenDiscard(blocks);

        await processBlocksAndCommit(tracker, blocks.slice(5, 8));

        expect(tracker.undoWindowWatermark).to.equal(8);
        expect(await storedWatermark()).to.equal(8);
    });
});

describe('Regression: the undo-window watermark across edge cases of a discard', function () {
    useTracker(this);

    it('keeps the marks as they were when the Q read faults, rather than resetting them to unknown', async function () {
        const blocks = buildCoinbaseChain(8, 0, 0);
        await processBlocksAndCommit(tracker, blocks.slice(0, 5));
        const read = tracker.db.db.get.bind(tracker.db.db);
        tracker.db.db.get = async (key, ...rest) => {
            if (Buffer.compare(Buffer.from(key), Q_UNDO_WATERMARK_KEY) === 0) throw new Error('store fault');
            return read(key, ...rest);
        };
        await tracker.reloadUndoWindow();
        tracker.db.db.get = read;
        expect(tracker.lastBlocks).to.have.length(5);
        expect(tracker.undoWindowWatermark).to.equal(5);
        expect(tracker.undoWindowWatermarkPersisted).to.equal(5);
    });

    it('leaves a mark that was already at the cap alone', async function () {
        const blocks = buildCoinbaseChain(15, 0, 0);
        await processBlocksAndCommit(tracker, blocks.slice(0, 13));
        expect(await storedWatermark()).to.equal(12);

        await tracker.db.beginTransaction();
        for (const block of blocks.slice(13, 15)) await processBlock(tracker, block);
        await tracker.discardInflightBatchForReorg(2);

        expect(tracker.undoWindowWatermark).to.equal(12);
        expect(await storedWatermark()).to.equal(12);
    });
});
