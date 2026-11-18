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

// Each place the loop discards a staged batch must put the undo window and its
// watermark back from the store together. The same-height tip swap has no loop
// scenario here that leaves the staged mark deeper than disk, so its wiring is
// pinned in the source beside the behavioural cases in undo_watermark_discard
// and the discard_undo_watermark regression.

const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const SRC = path.join(__dirname, '../../../src/XChainUtxoTracker');
const read = (name) => fs.readFileSync(path.join(SRC, name), 'utf8');

// The text from a discard (endTransaction(false)) to the next call that runs the reorg walk.
function afterDiscard(source, walk) {
    const at = source.indexOf('endTransaction(false)');
    expect(at, 'the discard is present').to.be.greaterThan(-1);
    const end = source.indexOf(walk, at);
    expect(end, 'the walk follows the discard').to.be.greaterThan(at);
    return source.slice(at, end);
}

describe('undo watermark reload at every batch discard', function () {
    it('reloads the window and the mark after the prev-hash rollback discards', function () {
        const between = afterDiscard(read('sync_loop_block_apply.js'), 'verifyReorgHandingBackTipRefusal.call');
        expect(between).to.include('await this.reloadUndoWindow()');
        expect(between).to.not.include('this.lastBlocks = await this.loadLastBlocksSortedByHeight()');
    });

    it('reloads the window and the mark after the same-height tip swap discards', function () {
        const source = read('sync_loop_node_tip.js');
        const swap = source.slice(source.indexOf('async function rollBackSameHeightTipSwap'));
        const between = afterDiscard(swap, 'verifyReorgHandingBackTipRefusal.call');
        expect(between).to.include('await this.reloadUndoWindow()');
        expect(between).to.not.include('this.lastBlocks = await this.loadLastBlocksSortedByHeight()');
    });

    it('reloads through reloadUndoWindow inside discardInflightBatchForReorg', function () {
        const source = read('last_blocks_window.js');
        const fn = source.slice(source.indexOf('async discardInflightBatchForReorg'));
        const body = fn.slice(0, fn.indexOf('async removeFromLastBlocks'));
        expect(body).to.include('await this.reloadUndoWindow()');
    });
});
