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

// ─── Regression #4634: bulk-sync tip-safety must cover the reorg window ────────
//
// The bulk-sync merger emits no W/K/M reorg-recovery indices (SPEC.md). The
// design relies on bulk-sync stopping at least undoBlocks below the tip so the
// live incremental worker builds W/K/M for every block inside the reorg window.
// The orchestrator default tip-safety was 10, below the per-chain undoBlocks
// (BTC 12, LTC 48, DOGE 120), so a reorg into the freshly seeded range left
// phantom (unspent, never-deleted) or missing (spent, never-restored) UTXOs.
// effectiveTipSafety() clamps tip-safety up to undoBlocks (the same value
// derive-keys uses to size the seeded N-window) whenever --to is not pinned.

const { expect } = require('chai');
const { effectiveTipSafety, resolveUndoBlocks } = require('../../src/bulk-sync/orchestrator');

describe('bulk-sync tip-safety clamp (#4634) @regression', function () {

    it('raises a too-small tip-safety up to the per-chain undoBlocks', function () {
        // Default orchestrator tip-safety of 10 is below every chain's undoBlocks.
        expect(effectiveTipSafety(10, null, 'bitcoin-mainnet')).to.equal(12);
        expect(effectiveTipSafety(10, null, 'litecoin-mainnet')).to.equal(48);
        expect(effectiveTipSafety(10, null, 'dogecoin-mainnet')).to.equal(120);
    });

    it('never lowers a tip-safety the operator set above undoBlocks', function () {
        expect(effectiveTipSafety(50, null, 'bitcoin-mainnet')).to.equal(50);   // > 12
        expect(effectiveTipSafety(200, null, 'dogecoin-mainnet')).to.equal(200); // > 120
    });

    it('leaves an explicit --to alone (operator owns the stop point; tip is unknown here)', function () {
        // With --to pinned, tip-safety is not used by the dump, so it is returned as-is.
        expect(effectiveTipSafety(10, 500000, 'dogecoin-mainnet')).to.equal(10);
    });

    it('guarantees the clamped stop point covers the seeded N-window for every chain', function () {
        // The clamp and the N-window must use the SAME undoBlocks, or a bulk-seeded
        // N entry could fall inside the live reorg window with no W/K/M behind it.
        for (const net of ['bitcoin-mainnet', 'litecoin-mainnet', 'dogecoin-mainnet',
                           'bitcoin-testnet', 'dogecoin-regtest']) {
            const undo = resolveUndoBlocks(net);
            expect(effectiveTipSafety(1, null, net)).to.be.at.least(undo);
        }
    });

    it('honors the XCHAIN_UNDO_BLOCKS_<COIN> override when clamping', function () {
        const prev = process.env.XCHAIN_UNDO_BLOCKS_BTC;
        process.env.XCHAIN_UNDO_BLOCKS_BTC = '200';
        try {
            expect(effectiveTipSafety(10, null, 'bitcoin-mainnet')).to.equal(200);
        } finally {
            if (prev === undefined) delete process.env.XCHAIN_UNDO_BLOCKS_BTC;
            else process.env.XCHAIN_UNDO_BLOCKS_BTC = prev;
        }
    });
});
