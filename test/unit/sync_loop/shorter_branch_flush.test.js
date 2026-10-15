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

// The node moves onto a shorter branch while the loop is catching up, so the
// tip the loop cached at its last refresh sits above the node's real tip. The
// "tip" flush trigger compares against that cache, so no staged block fires it,
// and the next refresh finds the cursor at the node's tip with the batch still
// open. The loop must commit those blocks before it reports synced or starts
// the mempool poller, whichever way the cursor reached the tip: through a
// prev-hash rollback, or with no rollback at all when the branch forks above
// the cursor.

const { expect } = require('chai');
const { buildChain, makeNode, useSyncLoopHarness } = require('./support/harness');

// The loop first indexes 0..39 and settles there; then the node grows to 299,
// the loop caches that tip and starts a batch, and once it fetches FIRE_AT the
// node switches to `branch`.
const FIRE_AT = 60;

// Drives one case: settle at 39, extend to `full`, switch to `branch` mid-batch,
// and record the committed tip every time the loop reports synced or runs the
// mempool poller after the switch. Stops at the first such reading.
async function catchUpOntoShorterBranch(h, makeBranch) {
    const node = makeNode(buildChain(40));
    const full = buildChain(300, 0, node.chain, 40);
    const branch = makeBranch(full);
    let phase = 0;
    const seen = await h.run(node, async (n, s) => {
        const t = h.tracker;
        if (phase === 0 && t.synced && t.lastCommittedHeight === 39) {
            phase = 1;
            node.chain = full;
            node.onBatch = (hs) => {
                if (phase === 2) s.maxFetched = Math.max(s.maxFetched || 0, ...hs);
                if (phase !== 1 || hs[0] < FIRE_AT) return;
                phase = 2;
                node.retired = full;
                node.chain = branch;
            };
            return null;
        }
        if (phase === 2 && (t.synced || t.mempoolInterval != null)) {
            s.syncedAt = { committed: await t.db.getLastBlockHeight(), hash: await t.db.getLastBlockHash(),
                synced: t.synced, mempoolStarted: t.mempoolInterval != null };
            return 'stop';
        }
        return null;
    });
    return { seen, node, branch };
}

describe('XChainUtxoTracker sync loop: catch-up onto a shorter branch commits before it reports synced', function () {
    const h = useSyncLoopHarness();

    it('commits the re-staged blocks after a prev-hash rollback onto a shorter branch', async function () {
        // Forks at 50, below the open batch, and ends at 120, far below the cached 299.
        const { seen, branch } = await catchUpOntoShorterBranch(h, (full) => buildChain(121, 1, full, 50));
        // Nothing committed is orphaned, so the walk counts no reorg; the prev-hash
        // path still runs and says so at warn.
        const warned = console.warn.getCalls().some((c) => String(c.args[0]).includes('A reorg has been detected'));
        expect(warned, 'the switch must reach the loop through the prev-hash rollback').to.equal(true);
        expect(seen.syncedAt, 'the loop must reach the new tip').to.not.equal(undefined);
        expect(seen.syncedAt.committed, 'synced or mempool-ready with blocks unwritten').to.equal(120);
        expect(seen.syncedAt.hash).to.equal(branch[120].hash);
        // The rollback drops the cached 299, so the loop re-reads the tip before it
        // re-stages and never asks the node for a height past 120.
        expect(seen.maxFetched, 'fetched past the new tip on a stale cached tip').to.equal(120);
    });

    it('commits the open batch when a shorter branch forks above the cursor and no rollback runs', async function () {
        // Forks at 100, above every block the batch has staged, and ends at 130.
        const { seen, branch } = await catchUpOntoShorterBranch(h, (full) => buildChain(131, 1, full, 100));
        const warned = console.warn.getCalls().some((c) => String(c.args[0]).includes('A reorg has been detected'));
        expect(warned, 'no rollback runs on this path').to.equal(false);
        expect(seen.syncedAt, 'the loop must reach the new tip').to.not.equal(undefined);
        expect(seen.syncedAt.committed, 'synced or mempool-ready with blocks unwritten').to.equal(130);
        expect(seen.syncedAt.hash).to.equal(branch[130].hash);
    });
});
