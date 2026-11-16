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

// Helpers over the sync-loop harness chains for the native history suites.

const crypto = require('crypto');
const bitcoin = require('bitcoinjs-lib');

// The P2PKH address the harness's coinbase at `height` on chain `tag` pays.
function coinbaseAddress(height, tag) {
    const hash = crypto.createHash('sha256').update('k' + height + ':' + tag).digest().subarray(0, 20);
    return bitcoin.payments.p2pkh({ hash, network: bitcoin.networks.regtest }).address;
}

function spendTxid(block) {
    return bitcoin.Block.fromHex(block.hex).transactions[1].getId();
}

function scriptOf(address) {
    return crypto.createHash('sha256').update(bitcoin.address.toOutputScript(address, bitcoin.networks.regtest)).digest();
}

// Every A record of one address, as [keyHex, valueHex], in key order.
async function historyRowsOf(db, address) {
    const prefix = Buffer.concat([Buffer.from([0x41]), scriptOf(address)]);
    const rows = [];
    for await (const [key, value] of db.db.iterator({ gte: prefix, lte: Buffer.concat([prefix, Buffer.alloc(36, 0xFF)]) })) {
        rows.push([key.toString('hex'), value.toString('hex')]);
    }
    return rows;
}

// Seeds every store the harness opens with `addresses` on the watch list, from
// genesis: their past is empty, so live ingest alone writes all their rows.
function watchFromGenesis(h, addresses) {
    h.seedMainStore(async (store) => {
        await store.addHistoryWatches(addresses.map((a) => ({
            script: scriptOf(a), start: 0, progress: { next: 0, done: false, open: [] } })));
    });
}

// Distinct block hashes under a one-byte key family.
async function blocksUnder(db, prefixByte) {
    const found = new Set();
    for await (const key of db.db.keys({ gte: Buffer.from([prefixByte]), lt: Buffer.from([prefixByte + 1]) })) {
        found.add(key.subarray(1, 33).toString('hex'));
    }
    return found;
}

// Resolves once `check()` is true, polling on real timers.
async function until(check, timeoutMs = 8000) {
    const deadline = process.hrtime.bigint() + BigInt(timeoutMs) * 1000000n;
    while (!(await check())) {
        if (process.hrtime.bigint() > deadline) throw new Error('condition not reached in ' + timeoutMs + ' ms');
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

module.exports = { coinbaseAddress, spendTxid, scriptOf, historyRowsOf, watchFromGenesis, blocksUnder, until };
