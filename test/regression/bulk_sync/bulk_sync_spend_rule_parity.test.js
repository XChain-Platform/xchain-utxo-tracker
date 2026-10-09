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

// Regression: the bulk spends stream and the live input pass must agree on which inputs are spends.
// (A bulk spend the live path skips would cancel an output a live-synced DB keeps.)

const crypto = require('crypto');
const { expect } = require('chai');

const { processBlock } = require('../../../src/bulk_sync/process_block.js');
const XChainUtxoTracker = require('../../../src/XChainUtxoTracker.js');

function rand32() { return crypto.randomBytes(32); }

// An input spending prevTxid:vout, with the prevout hash in wire (LE) order.
function spendInput(prevTxidHex, vout, extra = {}) {
    return Object.assign({ hash: Buffer.from(prevTxidHex, 'hex').reverse(), index: vout, script: Buffer.alloc(0) }, extra);
}

function buildBlock() {
    const prev = Array.from({ length: 5 }, () => rand32().toString('hex'));
    const coinbase = {
        id: rand32().toString('hex'),
        ins: [{ hash: Buffer.alloc(32), index: 0xFFFFFFFF, script: Buffer.alloc(0) }],
        outs: [],
    };
    const spender = {
        id: rand32().toString('hex'),
        ins: [
            spendInput(prev[0], 1),
            spendInput(prev[1], 2, { standard_input: false }),
            spendInput(prev[2], 3, { standard_input: true }),
            spendInput(prev[3], 4, { standard_input: null }),
            spendInput(prev[4], 5, { standard_input: 0 }),
        ],
        outs: [],
    };
    return { prev, block: { prevHash: rand32(), timestamp: 1700000000, transactions: [coinbase, spender] } };
}

function bulkSpendSet(block) {
    const spends = [];
    const writers = {
        outputs: { append() {} },
        spends: { append(prevHash8, index) { spends.push(`${Buffer.from(prevHash8).toString('hex')}:${index}`); } },
        meta: { writeBlock() {} },
    };
    processBlock(block, 1, rand32(), writers);
    return new Set(spends);
}

async function liveSpendSet(block) {
    const tracker = new XChainUtxoTracker('bitcoin-regtest', '127.0.0.1', '18443', 'u', 'p', 'spend-rule-parity', false);
    const spends = [];
    const db = {
        async removeOutputWithInput({ prevTxHash, prevOutputIndex }) { spends.push(`${prevTxHash}:${prevOutputIndex}`); },
        async insertInput() { throw new Error('removeSpent=true must not insert inputs'); },
        async insertInputHint() {},
    };
    for (const tx of block.transactions) {
        await tracker.parseTxInputs(db, tx, 'f'.repeat(64), false, true);
    }
    return new Set(spends);
}

describe('bulk-sync spend rule parity with the live input pass', function () {
    it('processBlock and parseTxInputs emit the same spend set', async function () {
        const { block } = buildBlock();
        const bulk = bulkSpendSet(block);
        const live = await liveSpendSet(block);
        expect([...bulk].sort()).to.deep.equal([...live].sort());
    });

    it('skips coinbase and falsy standard_input inputs on both paths, and keeps standard ones', async function () {
        const { prev, block } = buildBlock();
        const key = (txid, vout) => `${txid.substring(0, 16)}:${vout}`;
        for (const set of [bulkSpendSet(block), await liveSpendSet(block)]) {
            expect(set.has(key(prev[0], 1))).to.equal(true);
            expect(set.has(key(prev[2], 3))).to.equal(true);
            expect(set.has(key(prev[1], 2))).to.equal(false);
            expect(set.has(key(prev[3], 4))).to.equal(false);
            expect(set.has(key(prev[4], 5))).to.equal(false);
            expect(set.has(key('00'.repeat(32), 0xFFFFFFFF))).to.equal(false);
            expect(set.size).to.equal(2);
        }
    });
});
