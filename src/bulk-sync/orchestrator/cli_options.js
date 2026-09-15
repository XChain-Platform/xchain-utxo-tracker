'use strict'

/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 **********************************************************************/

const { resolveUndoBlocks } = require('../merger/derive_keys.js')

// Every option's value before the command line is read.
function defaultArgs() {
    return {
        network:    null,
        from:       0,
        to:         null,      // null = use tip - tipSafety
        tipSafety:  10,
        // Named opt-in for the one unsafe shape effectiveTipSafety cannot clamp: an
        // explicit --to inside the live undo window. Threaded to dump.js, which is
        // where the real tip is known and where the guard actually runs.
        allowUndoWindow: false,
        chunkSize:  10000,
        out:        null,      // working directory for all artifacts
        db:         null,      // final DB path (classic-level / LevelDB)
        workers:    null,      // null = auto (number of dump chunks)
        ramBudget:  1024,      // MB for external sort
        batchSize:  10000,     // loader batch size
        // Free consumed merge/ files when free disk drops below this many MB.
        // 0 disables cleanup (preserves all resume points). Default 100 GB:
        // generous enough that runs with comfortable disk keep their resume
        // files, but trips before the next sort can ENOSPC on a tight disk.
        cleanupThresholdMb: 100 * 1024,
        skipDump:    false,
        // null = unset; resolveVerifyDefaults() turns null into ON for
        // mainnet networks (safety over read-pass cost) and OFF everywhere
        // else. Explicit --[no-]verify-* flags always win.
        verifyChain: null,
        verifyMerkle: null,    // implies verifyChain; adds tx-body merkle rebuild
        skipParse:   false,
        // Default matches XChainUtxoTracker.REMOVE_SPENT = true. Skipping
        // I/J cuts ~130 GB of disk and ~30-60 min on mainnet because the
        // live tracker never persists those records anyway.
        removeSpent: true,
    }
}

// A mainnet bootstrap seeds the production UTXO set, so a silently corrupt
// dump (truncated .xdmp, disk bitrot, node fed a bad block) is a
// consensus-facing hazard: verification defaults ON there. Non-mainnet
// (regtest/testnet) keeps the fast path.
function isMainnetNetwork(network) {
    return /-mainnet$/.test(String(network))
}

// Resolve null (unset) verify flags per network, then enforce the
// merkle-implies-chain invariant: merkle verification walks the header
// chain anyway, so verifyMerkle without verifyChain is not a real mode.
function resolveVerifyDefaults(args) {
    const mainnet = isMainnetNetwork(args.network)
    if (args.verifyMerkle === null) args.verifyMerkle = mainnet
    if (args.verifyChain  === null) args.verifyChain  = mainnet
    if (args.verifyMerkle) args.verifyChain = true
    return args
}

// Reorg-recovery invariant (SPEC.md: "The `K` and `M` reorg-recovery reverse indices are
// skipped entirely. The `W` creation-block reverse index IS seeded"): the merger emits no
// K/M reorg-recovery indices, so any block bulk-sync seeds directly is un-recoverable on
// reorg. W alone is not enough, and it is itself only seeded for the windowed range
// derive-keys emits. The design stops bulk-sync at least undoBlocks below the tip and lets
// the live incremental worker build W/K/M for every block inside the reorg
// window. With tip-safety < undoBlocks the seeded N-window includes bulk-synced blocks
// with no K/M, so a reorg into that range leaves phantom (unspent, never-deleted) or
// missing (spent, never-restored) UTXOs until a full re-index. When --to is not
// pinned we clamp tip-safety up to undoBlocks (the same per-chain value derive-keys uses
// to size the N-window, so the stop point and the seeded window stay in lockstep). Clamp
// up only: an operator may choose a LARGER margin, never a smaller one. An explicit --to
// is returned as-is because the tip is unknown here and the clamp has nothing to compare
// against; the invariant is enforced instead in dump.js, at the one point the real tip IS
// resolved, where an explicit --to inside the undo window is rejected unless
// --allow-undo-window names the override. A warning-only override used to be enough to
// let an unsafe --to through unnoticed, which is why the guard now fails loud instead.
function effectiveTipSafety(tipSafety, to, network) {
    if (to !== null) return tipSafety
    return Math.max(tipSafety, resolveUndoBlocks(network))
}

module.exports = { defaultArgs, isMainnetNetwork, resolveVerifyDefaults, effectiveTipSafety }
