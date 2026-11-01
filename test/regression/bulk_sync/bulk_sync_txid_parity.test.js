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

// Regression: bulk sync and the live output pass key a transaction by one txid.
//
// Both paths derive the txid from the parsed bytes (getHash / getId) and neither
// honours a tx.id property. A one-sided edit would key the same transaction under
// two txids with nothing failing, so both cases are pinned against a real transaction.

const crypto = require('crypto');
const { expect } = require('chai');
const { Transaction } = require('bitcoinjs-lib');

const { processBlock } = require('../../../src/bulk_sync/process_block.js');
const XChainUtxoTracker = require('../../../src/XChainUtxoTracker.js');

function realTx() {
    const tx = new Transaction();
    tx.version = 2;
    tx.addInput(crypto.randomBytes(32), 1);
    tx.addOutput(Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), crypto.randomBytes(20), Buffer.from([0x88, 0xac])]), 5000);
    tx.addOutput(Buffer.concat([Buffer.from([0x00, 0x14]), crypto.randomBytes(20)]), 7000);
    return tx;
}

function bulkTxids(tx) {
    const seen = new Set();
    const writers = {
        outputs: { append(txid) { seen.add(Buffer.from(txid).toString('hex')); } },
        spends: { append() {} },
        meta: { writeBlock() {} },
    };
    processBlock({ prevHash: crypto.randomBytes(32), timestamp: 1700000000, transactions: [tx] }, 1, crypto.randomBytes(32), writers);
    return [...seen];
}

async function liveTxids(tx) {
    const tracker = new XChainUtxoTracker('bitcoin-regtest', '127.0.0.1', '18443', 'u', 'p', 'txid-parity', false);
    const seen = new Set();
    const db = {
        async insertTransaction({ hash }) { seen.add(hash); },
        async insertOutput({ fullTxHash }) { seen.add(fullTxHash); },
    };
    await tracker.parseTxOutputs(db, tx, 'f'.repeat(64), 1, false, false);
    return [...seen];
}

describe('Regression (bulk-sync): txid parity with the live output pass', function () {
    it('keys a decoded transaction by its parsed-bytes txid on both paths', async function () {
        const tx = realTx();
        expect(bulkTxids(tx)).to.deep.equal([tx.getId()]);
        expect(await liveTxids(tx)).to.deep.equal([tx.getId()]);
    });

    it('ignores a stray tx.id property on both paths', async function () {
        const tx = realTx();
        tx.id = crypto.randomBytes(32).toString('hex');
        expect(bulkTxids(tx)).to.deep.equal([tx.getId()]);
        expect(await liveTxids(tx)).to.deep.equal([tx.getId()]);
    });
});
