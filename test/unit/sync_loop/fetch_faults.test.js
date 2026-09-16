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

// Node faults the sync loop rides out or fails loud on: a failed or unsynced
// tip read, transient and permanent block fetch faults, and AuxPoW strip
// faults that escalate to per-tx reassembly.

const { expect } = require('chai');
const { MAX_BLOCK_FETCH_RETRIES } = require('../../../src/XChainUtxoTracker');
const { buildChain, makeNode, useSyncLoopHarness } = require('./support/harness');

describe('XChainUtxoTracker sync loop: node faults', function () {
    const h = useSyncLoopHarness();

    it('waits out a failed tip read and an unsynced node before indexing', async function () {
        const node = makeNode(buildChain(13));
        node.faults.info = [new Error('node unreachable')];
        node.progress = 0.5;
        const read = node.connector.getBlockchainInfo;
        node.connector.getBlockchainInfo = async function () {
            const info = await read.call(this);
            if (node.infoCalls === 3) node.progress = 1;
            return info;
        };
        const seen = await h.run(node, (n) => (n >= 4 ? 'stop' : null));
        expect(seen.height).to.equal(12);
    });

    it('retries a transient block fetch fault and then indexes', async function () {
        const node = makeNode(buildChain(13));
        node.faults.batch = [new Error('batch down'), new Error('batch down')];
        const seen = await h.run(node, (n) => (n >= 5 ? 'stop' : null));
        expect(seen.height).to.equal(12);
        expect(h.tracker.blockFetchDesync).to.equal(null);
    });

    it('fails loud with a desync error once the node cannot serve the next block', async function () {
        const node = makeNode(buildChain(13));
        const pruned = () => new Error('pruned');
        node.faults.batch = Array.from({ length: 50 }, pruned);
        node.faults.hash = Array.from({ length: 50 }, pruned);
        let err = null;
        try { await h.run(node, () => null); } catch (e) { err = e; }
        expect(err && err.message).to.match(/Block-fetch desync/);
        expect(h.tracker.blockFetchDesync).to.include({ height: 0, failures: MAX_BLOCK_FETCH_RETRIES });
    });

    it('falls back to per-tx reassembly after repeated AuxPoW strip faults', async function () {
        const node = makeNode(buildChain(13));
        const stripFault = () => { const e = new Error('bad auxpow'); e.auxPowParseFailure = true; return e; };
        node.faults.batch = [null, ...Array.from({ length: 12 }, stripFault)];
        const seen = await h.run(node, (n) => (n >= 16 ? 'stop' : null), { network: 'dogecoin-regtest' });
        expect(node.reassembled).to.equal(1);
        expect(seen.height).to.equal(12);
    });
});
