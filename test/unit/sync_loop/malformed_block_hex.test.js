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

// A node reply that is not whole block hex is a fetch fault the loop retries,
// never a decode failure that leaves start() and exits the process.

const { expect } = require('chai');
const BlockchainConnector = require('../../../src/chain/blockchain_connector');
const { buildChain, makeNode, useSyncLoopHarness } = require('./support/harness');

// A real connector whose transport serves `node.chain` over JSON-RPC and answers
// the first `bad` getblock replies with a truncated, odd-length string.
function serveOverRpc(node, bad) {
    const real = new BlockchainConnector('127.0.0.1', '8332', 'u', 'p');
    let left = bad;
    const answer = (req) => {
        if (req.method === 'getblockhash') return node.chain[req.params[0]].hash;
        const block = node.chain.find((b) => b.hash === req.params[0]);
        if (left > 0) { left--; return block.hex.slice(0, 101); }
        return block.hex;
    };
    real.client.post = async (url, body) => {
        const reqs = Array.isArray(body) ? body : [body];
        const data = reqs.map((r) => ({ id: r.id, result: answer(r) }));
        return { data: Array.isArray(body) ? data : data[0] };
    };
    node.connector.getBlocksBatch = (hs) => real.getBlocksBatch(hs);
    node.connector.getBlock = (hash) => real.getBlock(hash);
    return () => left;
}

describe('XChainUtxoTracker sync loop: malformed block hex', function () {
    const h = useSyncLoopHarness();

    it('retries a truncated batched getblock reply and then indexes', async function () {
        const node = makeNode(buildChain(13));
        const remaining = serveOverRpc(node, 2);
        const seen = await h.run(node, (n) => (n >= 6 ? 'stop' : null));
        expect(remaining()).to.equal(0);
        expect(seen.height).to.equal(12);
        expect(h.tracker.blockFetchDesync).to.equal(null);
    });
});
