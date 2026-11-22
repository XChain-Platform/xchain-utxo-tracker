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

// Live ingest of native history through the real sync loop: rows only for
// watched addresses, the rows a reorg unwinds, the reverse index the undo window
// prunes, and no row for a data output.

const { expect } = require('chai');
const bitcoin = require('bitcoinjs-lib');
const LevelUpStore = require('../../../src/store/level_up_db');
const XChainUtxoTracker = require('../../../src/XChainUtxoTracker');
const { buildChain, makeNode, useSyncLoopHarness } = require('../sync_loop/support/harness');
const { coinbaseAddress, spendTxid, scriptOf, historyRowsOf, watchFromGenesis, blocksUnder } = require('./support/chain_history');

function historyOf(tracker, address) {
    return tracker.getNativeHistory([address], { limit: 100 }, { ip: 'test' });
}

describe('native history ingest: only watched addresses get rows', function () {
    const h = useSyncLoopHarness();

    it('records a watched address\'s receipt and spend and nothing for an unwatched one', async function () {
        const node = makeNode(buildChain(8));
        const watched = coinbaseAddress(1, 0);
        const unwatched = coinbaseAddress(2, 0);
        watchFromGenesis(h, [watched]);
        const seen = await h.run(node, (n) => (n >= 2 ? 'stop' : null), {
            inspect: async (s) => {
                s.history = await historyOf(h.tracker, watched);
                s.unwatchedRows = await historyRowsOf(h.tracker.db, unwatched);
                s.allRows = (await h.tracker.db.db.keys({ gte: Buffer.from([0x41]), lt: Buffer.from([0x42]) }).all()).length;
            }
        });
        expect(seen.height).to.equal(7);
        expect(seen.history.addressStatus[watched]).to.deep.equal({ history_status: 'complete', history_from_height: 0 });
        expect(seen.history.transactions).to.deep.equal([
            { txid: spendTxid(node.chain[3]), height: 3, time: 1600000000 + 3 * 600, net: '-5000000000',
              addresses: { [watched]: { received: '0', sent: '5000000000', net: '-5000000000' } } },
            { txid: node.chain[1].coinbase, height: 1, time: 1600000000 + 600, net: '5000000000',
              addresses: { [watched]: { received: '5000000000', sent: '0', net: '5000000000' } } },
        ]);
        expect(seen.unwatchedRows).to.deep.equal([]);
        expect(seen.allRows).to.equal(2);
    });
});

describe('native history ingest: reorgs and the undo window', function () {
    const h = useSyncLoopHarness();

    it('drops the orphaned blocks\' rows and records the replacement chain\'s', async function () {
        const node = makeNode(buildChain(13));
        const spentBefore = coinbaseAddress(9, 0);
        watchFromGenesis(h, [spentBefore, coinbaseAddress(11, 0), coinbaseAddress(11, 7)]);
        const seen = await h.run(node, (n) => {
            if (n === 1) { node.retired = node.chain; node.chain = buildChain(16, 7, node.chain, 10); }
            return n >= 3 ? 'stop' : null;
        }, {
            inspect: async (s) => {
                s.spent = await historyOf(h.tracker, spentBefore);
                s.orphan = await historyOf(h.tracker, coinbaseAddress(11, 0));
                s.replacement = await historyOf(h.tracker, coinbaseAddress(11, 7));
            }
        });
        expect(h.tracker.reorgCount).to.equal(1);
        expect(seen.spent.transactions.map((t) => [t.height, t.txid])).to.deep.equal([
            [11, spendTxid(node.chain[11])], [9, node.chain[9].coinbase],
        ]);
        expect(seen.orphan.transactions).to.deep.equal([]);
        // The harness spends every odd height's coinbase two blocks up, so 11's goes at 13.
        expect(seen.replacement.transactions.map((t) => t.txid)).to.deep.equal([spendTxid(node.chain[13]), node.chain[11].coinbase]);
    });

    it('prunes the reverse index with the undo window and keeps the history rows', async function () {
        const node = makeNode(buildChain(30));
        const addresses = Array.from({ length: 30 }, (_, i) => coinbaseAddress(i, 0));
        watchFromGenesis(h, addresses);
        const seen = await h.run(node, (n) => (n >= 2 ? 'stop' : null), {
            inspect: async (s) => {
                s.vBlocks = await blocksUnder(h.tracker.db, 0x56);
                s.nBlocks = await blocksUnder(h.tracker.db, 0x4E);
                s.old = await historyOf(h.tracker, coinbaseAddress(1, 0));
            }
        });
        expect(seen.height).to.equal(29);
        expect(seen.nBlocks.size).to.be.within(1, h.tracker.undoBlocks);
        expect([...seen.vBlocks].sort()).to.deep.equal([...seen.nBlocks].sort());
        expect(seen.old.transactions.map((t) => t.height)).to.deep.equal([3, 1]);
    });
});

describe('native history ingest: data outputs', function () {
    it('gives an OP_RETURN output no history row and its watched paying address one', async function () {
        const tracker = new XChainUtxoTracker('bitcoin-regtest', '127.0.0.1', 1, 'u', 'p', 'history-opreturn', false);
        const db = new LevelUpStore('history-opreturn-' + Math.random(), true);
        await db.createDatabase();
        const tx = new bitcoin.Transaction();
        tx.addInput(Buffer.alloc(32, 1), 0);
        const payee = coinbaseAddress(500, 0);
        const dataScript = bitcoin.payments.embed({ data: [Buffer.from('xchain')] }).output;
        tx.addOutput(bitcoin.address.toOutputScript(payee, bitcoin.networks.regtest), 7000n);
        tx.addOutput(dataScript, 0n);
        const blockHash = 'cd'.repeat(32);
        db.historyScripts = new Set([scriptOf(payee), require('crypto').createHash('sha256').update(dataScript).digest()]
            .map((b) => b.toString('latin1')));
        await db.beginTransaction();
        await db.insertBlock({ hash: blockHash, height: 5, timestamp: 1234, previousHash: 'ab'.repeat(32) });
        await tracker.parseTxOutputs(db, tx, blockHash, 5, false, true);
        await db.endTransaction();
        const aKeys = await db.db.keys({ gte: Buffer.from([0x41]), lt: Buffer.from([0x42]) }).all();
        await db.close();
        expect(aKeys.map((k) => k.subarray(1, 33))).to.deep.equal([scriptOf(payee)]);
    });
});
