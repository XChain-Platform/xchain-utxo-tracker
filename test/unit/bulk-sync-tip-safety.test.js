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
// The bulk-sync merger emits no K/M reorg-recovery indices (SPEC.md; W IS seeded,
// windowed to the derive-keys range, but W alone cannot recover a reorg). The
// design relies on bulk-sync stopping at least undoBlocks below the tip so the
// live incremental worker builds W/K/M for every block inside the reorg window.
// The orchestrator default tip-safety was 10, below the per-chain undoBlocks
// (BTC 12, LTC 48, DOGE 120), so a reorg into the freshly seeded range left
// phantom (unspent, never-deleted) or missing (spent, never-restored) UTXOs.
// effectiveTipSafety() clamps tip-safety up to undoBlocks (the same value
// derive-keys uses to size the seeded N-window) whenever --to is not pinned.

const { expect } = require('chai');
const { effectiveTipSafety, resolveUndoBlocks, parseArgs } = require('../../src/bulk-sync/orchestrator');
const dump = require('../../src/bulk-sync/dump');

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

    it('leaves an explicit --to alone (the tip is unknown here; dump.js owns that guard)', function () {
        // With --to pinned, tip-safety is not used by the dump, so it is returned as-is.
        // The invariant for that shape is enforced in dump.js against the resolved tip
        // (see the explicit --to undo-window guard below).
        expect(effectiveTipSafety(10, 500000, 'dogecoin-mainnet')).to.equal(10);
    });

    it('guarantees the clamped stop point covers the seeded N-window for every chain', function () {
        // The clamp and the N-window must use the SAME undoBlocks, or a bulk-seeded
        // N entry could fall inside the live reorg window with no K/M behind it.
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

// ─── Regression : the explicit --to escape from that clamp ────────────
//
// effectiveTipSafety returns an explicit --to unclamped by design (the orchestrator
// has not resolved a tip, so it has nothing to compare against), and main() only
// logged a warning, which an automated or CI invocation swallows. dump.js is the one
// place the real tip IS known, so the invariant is enforced there and the only way
// past it is the named --allow-undo-window override.
describe('bulk-sync explicit --to undo-window guard () @regression', function () {

    // BTC undoBlocks = 12, so with a tip of 1000 the last safe endpoint is 988.
    const TIP = 1000;
    const NET = 'bitcoin-mainnet';

    it('rejects an explicit --to inside the live undo window', function () {
        expect(() => dump.assertExplicitToOutsideUndoWindow(989, TIP, NET, false))
            .to.throw(/live undo window/);
        expect(() => dump.assertExplicitToOutsideUndoWindow(TIP, TIP, NET, false))
            .to.throw(/--allow-undo-window/);
    });

    it('names the safe endpoint the operator should use instead', function () {
        expect(() => dump.assertExplicitToOutsideUndoWindow(1000, TIP, NET, false))
            .to.throw(/Lower --to to 988/);
    });

    it('passes an explicit --to at or below the safe endpoint', function () {
        expect(dump.assertExplicitToOutsideUndoWindow(988, TIP, NET, false)).to.equal(988);
        expect(dump.assertExplicitToOutsideUndoWindow(500, TIP, NET, false)).to.equal(988);
    });

    it('lets --allow-undo-window through, still warning so the risky choice is logged', function () {
        const prev = console.error;
        const lines = [];
        console.error = (...a) => lines.push(a.join(' '));
        try {
            expect(dump.assertExplicitToOutsideUndoWindow(1000, TIP, NET, true)).to.equal(988);
        } finally {
            console.error = prev;
        }
        expect(lines.join('\n')).to.match(/allow-undo-window set/);
    });

    it('tracks the XCHAIN_UNDO_BLOCKS_<COIN> override, so both horizons stay single-sourced', function () {
        const prev = process.env.XCHAIN_UNDO_BLOCKS_BTC;
        process.env.XCHAIN_UNDO_BLOCKS_BTC = '100';
        const prevErr = console.error;
        console.error = () => {};   // resolveUndoBlocks warns past MAX_SAFE; irrelevant here
        try {
            // Safe endpoint moves from 988 to 900 with the wider window.
            expect(dump.assertExplicitToOutsideUndoWindow(900, TIP, NET, false)).to.equal(900);
            expect(() => dump.assertExplicitToOutsideUndoWindow(901, TIP, NET, false))
                .to.throw(/live undo window/);
        } finally {
            console.error = prevErr;
            if (prev === undefined) delete process.env.XCHAIN_UNDO_BLOCKS_BTC;
            else process.env.XCHAIN_UNDO_BLOCKS_BTC = prev;
        }
    });

    it('accepts --allow-undo-window on both CLIs, so the override reaches the child', function () {
        const base = ['node', 'orchestrator.js', '--network', NET, '--out', '/tmp/o', '--db', '/tmp/d'];
        expect(parseArgs(base).allowUndoWindow).to.equal(false);
        expect(parseArgs(base.concat('--allow-undo-window')).allowUndoWindow).to.equal(true);

        const dumpBase = ['node', 'dump.js', '--network', NET, '--out', '/tmp/o'];
        expect(dump.parseArgs(dumpBase).allowUndoWindow).to.equal(undefined);
        expect(dump.parseArgs(dumpBase.concat('--allow-undo-window')).allowUndoWindow).to.equal(true);
    });
});
