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

// Two transactions whose txids share their first 8 bytes. Every record that
// names a txid (T, I, O, H, J, K, M, W) must key on the whole txid, or the second
// transaction's records land on the first one's keys and a spend of one
// removes the other's output. A real pair costs about 2^32 txid grinding, so
// the decoder here reports the second coinbase's txid with the first one's
// 8-byte prefix, which is exactly what a ground pair decodes to.

const crypto = require('crypto');
const { expect } = require('chai');
const sinon = require('sinon');
const bitcoin = require('bitcoinjs-lib');
const XChainBlockDecoder = require('../../../src/chain/XChainBlockDecoder');
const { buildChain, makeNode, useSyncLoopHarness } = require('./support/harness');

// The harness chain spends the coinbase two blocks down at every odd height
// from 3, so block 3's coinbase (A) is spent at block 5, and block 4's coinbase
// (B) is never spent. B is reported with A's 8-byte prefix.
const A_HEIGHT = 3;
const B_HEIGHT = 4;

const scriptHashOf = (script) => crypto.createHash('sha256').update(script).digest('hex');

// The two coinbases' vout-0 scripts and B's colliding txid.
function collidingPair(chain) {
    const coinbase = (h) => bitcoin.Block.fromHex(chain[h].hex).transactions[0];
    const a = coinbase(A_HEIGHT), b = coinbase(B_HEIGHT);
    return {
        aTxid: a.getId(),
        bTxid: a.getId().slice(0, 16) + b.getId().slice(16),
        realBTxid: b.getId(),
        aScript: scriptHashOf(a.outs[0].script),
        bScript: scriptHashOf(b.outs[0].script),
    };
}

// Makes the decoder report B's txid with A's prefix.
function reportCollidingTxid(pair) {
    const decode = XChainBlockDecoder.prototype.blockFromHex;
    sinon.stub(XChainBlockDecoder.prototype, 'blockFromHex').callsFake(function (hex) {
        const block = decode.call(this, hex);
        for (const tx of block.transactions) {
            if (tx.getId() === pair.realBTxid) tx.getId = () => pair.bTxid;
        }
        return block;
    });
}

describe('XChainUtxoTracker sync loop: txids sharing an 8-byte prefix', function () {
    const h = useSyncLoopHarness();

    it('keeps the unspent output of a tx whose txid shares its first 8 bytes with a spent one', async function () {
        const node = makeNode(buildChain(8));
        const pair = collidingPair(node.chain);
        expect(pair.bTxid.slice(0, 16)).to.equal(pair.aTxid.slice(0, 16));
        expect(pair.bTxid).to.not.equal(pair.aTxid);
        reportCollidingTxid(pair);

        const seen = await h.run(node, () => 'stop', {
            inspect: async (s) => {
                s.a = await h.tracker.db.getOutputsScriptPubKey(pair.aScript);
                s.b = await h.tracker.db.getOutputsScriptPubKey(pair.bScript);
                s.bTxBlock = await h.tracker.db.getTxBlock(pair.bTxid);
            },
        });

        expect(seen.height).to.equal(7);
        // A:0 was spent at block 5; B:0 never was.
        expect(seen.a.filter((o) => o.vout === 0).map((o) => o.fullTxid), 'the spent output is still served').to.deep.equal([]);
        expect(seen.b.filter((o) => o.vout === 0).map((o) => o.fullTxid), 'the unspent output was removed by the other tx\'s spend')
            .to.deep.equal([pair.bTxid]);
        expect(seen.bTxBlock && seen.bTxBlock.block_hash).to.equal(node.chain[B_HEIGHT].hash);
    });
});
