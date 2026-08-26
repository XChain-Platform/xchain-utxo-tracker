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
//
// Generator for the shared utxo-tracker -> encoder UTXO-record conformance
// fixture. Emits test/fixtures/utxo-record-conformance.json, the golden
// artifact consumed by BOTH this repo (producer drift guard,
// test/conformance/utxoRecordEmit.test.js) and xchain-encoder (consumer gate
// conformance, test/conformance/utxoRecordConformance.test.js, over a vendored
// byte-identical copy). Regenerate with:
//   node test/conformance/generateUtxoRecordFixture.js
// and review the diff, then re-vendor the copy in xchain-encoder.
//
// WHY THIS EXISTS. The record this tracker serves over get_utxos is a
// cross-repo contract, and until this fixture it was pinned only by two
// hand-written restatements inside the consumer (xchain-encoder
// src/UtxoTracker.js's shape gate and src/validator.js validateUtxoEntry) plus
// one prose comment on this side (test/boundary/confirmations.test.js). Every
// OUTBOUND seam the platform has - compiledPushSize, the roundtrip fixture, the
// action manifest - is bound executably; this inbound one was not, and the only
// shared artifact, xchain-encoder/test/integration/helpers/utxoFactory.js, had
// already drifted to a JS Number `value` with no amount/height/coinbase.
//
// The records are produced by the REAL emit path (getUtxosAddress over a real
// LevelDB store fed by the real block-parse passes), never hand-written, so a
// rename or a unit change on this side fails the guard rather than passing it.
//
// DETERMINISM. Every txid and block hash below is fixed, and the integration
// harness's Date.now()-seeded makeTxId is deliberately not used: re-running this
// generator must produce a byte-identical file or the drift guard is measuring
// the clock.

const fs = require('fs');
const path = require('path');
const {
    TEST_KEYS,
    makeTx,
    makeOutput,
    makeCoinbaseInput,
    makeBlock,
    processBlocksAndCommit,
    createTestTracker,
    closeTracker
} = require('../integration/helpers.js');
const XChainUtxoTracker = require('../../src/XChainUtxoTracker.js');

// Fixed ids. A txid is a 64-hex string and a block hash is a 64-hex string;
// nothing here needs them to hash to anything, only to be stable.
const TXID = {
    confirmed:       'c0'.repeat(32),
    bigValue:        'b1'.repeat(32),
    matureCoinbase:  '11'.repeat(32),
    immatureCoinbase:'12'.repeat(32),
    mempool:         'e0'.repeat(32)
};
const BLOCK_HASH = (h) => h.toString(16).padStart(2, '0').repeat(32);

// Chain geometry. The node tip sits at NODE_TIP; the tracker commits up to
// TIP_HEIGHT, so the fixture's `sync` sample carries a real (small) lag rather
// than a synthetic zero.
const TIP_HEIGHT = 120;
const NODE_TIP = 121;
const COINBASE_MATURITY = 100;

// Above 2^53-1 satoshis: the DOGE consolidation shape `value` is a decimal
// string for. A consumer that parsed it as a JS Number would lose the last
// digit here, which is the whole reason the field is a string.
const BIG_VALUE_SATS = 9007199254740993n;

// Build the fixture from the live tracker. Exported so the producer drift guard
// (utxoRecordEmit.test.js) re-runs the SAME generation against the SAME code and
// compares, rather than restating the expected records in a second place where
// they could drift apart quietly.
async function buildFixture () {
    const tracker = await createTestTracker();
    tracker.blockchainInfoLastBlock = TIP_HEIGHT;
    tracker.latestKnownChainTip = NODE_TIP;
    tracker.coinbaseMaturity = COINBASE_MATURITY;

    const key = TEST_KEYS[0];
    const address = key.address;

    // Height 1: a mature coinbase (TIP_HEIGHT - 1 + 1 confirmations, well past
    // COINBASE_MATURITY) and, in a second block, an ordinary confirmed payment
    // plus the above-2^53-1 output.
    const matureCoinbaseTx = makeTx({
        txid: TXID.matureCoinbase,
        ins: [makeCoinbaseInput()],
        outs: [makeOutput(0, 5000000000)]
    });
    const confirmedTx = makeTx({
        txid: TXID.confirmed,
        ins: [],
        outs: [makeOutput(0, 250000)]
    });
    const bigValueTx = makeTx({
        txid: TXID.bigValue,
        ins: [],
        outs: [{ value: BIG_VALUE_SATS, script: key.script }]
    });
    // Height TIP_HEIGHT: a coinbase with fewer than COINBASE_MATURITY
    // confirmations. It must be WITHHELD from the served list; a node rejects
    // the spend, so serving it would hand the encoder an input that can never
    // confirm.
    const immatureCoinbaseTx = makeTx({
        txid: TXID.immatureCoinbase,
        ins: [makeCoinbaseInput()],
        outs: [makeOutput(0, 5000000000)]
    });

    const blocks = [
        makeBlock(1, '00'.repeat(32), [matureCoinbaseTx], BLOCK_HASH(1)),
        makeBlock(2, BLOCK_HASH(1), [confirmedTx, bigValueTx], BLOCK_HASH(2)),
        makeBlock(TIP_HEIGHT, BLOCK_HASH(2), [immatureCoinbaseTx], BLOCK_HASH(3))
    ];
    await processBlocksAndCommit(tracker, blocks);

    // An unconfirmed output: height null, confirmations 0. This is the edge the
    // consumer's `confirmations == 0` unconfirmed filter turns on and the one
    // the drifted stub never carried.
    const mempoolTx = makeTx({
        txid: TXID.mempool,
        ins: [],
        outs: [makeOutput(0, 777000)]
    });
    await tracker.mempoolDb.beginTransaction();
    await tracker.parseTransaction(tracker.mempoolDb, mempoolTx, null, -1, true);
    await tracker.mempoolDb.endTransaction();

    const served = await tracker.getUtxosAddress(address);
    // Sort by outpoint so LevelDB iteration order cannot make the artifact
    // churn between runs.
    served.sort((a, b) => (a.txid + ':' + a.vout).localeCompare(b.txid + ':' + b.vout));

    const servedKeys = new Set(served.map((u) => u.txid + ':' + u.vout));
    if (servedKeys.has(TXID.immatureCoinbase + ':0')) {
        throw new Error('immature coinbase output was SERVED; the withhold filter this fixture pins is gone');
    }
    for (const expected of [TXID.confirmed, TXID.bigValue, TXID.matureCoinbase, TXID.mempool]) {
        if (!servedKeys.has(expected + ':0')) {
            throw new Error(`expected served outpoint ${expected}:0 is missing; the generator no longer covers its case`);
        }
    }
    const big = served.find((u) => u.txid === TXID.bigValue);
    if (typeof big.value !== 'string' || BigInt(big.value) !== BIG_VALUE_SATS) {
        throw new Error(`value must be served as an exact satoshi decimal string, got ${typeof big.value} ${big.value}`);
    }

    // The freshness sibling get_utxos carries beside the list (api.js
    // getFreshnessMeta -> computeFreshness). Pure and static, so it is
    // generated here rather than copied.
    const sync = XChainUtxoTracker.computeFreshness(TIP_HEIGHT, NODE_TIP, true, {
        mempoolReconverged: true,
        halted: false,
        haltReason: null
    });

    const fixture = {
        _comment: 'Shared utxo-tracker -> encoder UTXO-record conformance fixture. Generated by ' +
            'xchain-utxo-tracker/test/conformance/generateUtxoRecordFixture.js from the REAL ' +
            'getUtxosAddress emit path; regenerate and re-vendor the xchain-encoder copy on change. ' +
            'servedRecords is what get_utxos returns for the address; withheldOutpoints are outputs ' +
            'the tracker deliberately does NOT serve; sync is the freshness sibling the encoder ' +
            'gates create_tx on. value is SATOSHIS as an exact decimal string (it can exceed ' +
            '2^53-1); amount is the derived coin-denominated display string and must never be spent.',
        network: 'bitcoin-regtest',
        address,
        scriptPubKey: key.scriptHex,
        tip: { trackerHeight: TIP_HEIGHT, nodeHeight: NODE_TIP, coinbaseMaturity: COINBASE_MATURITY },
        servedRecords: served.map((u) => ({
            txid: u.txid,
            vout: u.vout,
            value: u.value,
            amount: u.amount,
            height: u.height,
            coinbase: u.coinbase,
            confirmations: u.confirmations,
            scriptPubKey: u.scriptPubKey
        })),
        withheldOutpoints: [
            {
                txid: TXID.immatureCoinbase,
                vout: 0,
                why: 'immature coinbase: confirmations below coinbaseMaturity, so the spend can never confirm'
            }
        ],
        sync
    };

    await closeTracker(tracker);
    return fixture;
}

const FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', 'utxo-record-conformance.json');

async function main () {
    const fixture = await buildFixture();
    fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
    fs.writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2) + '\n');
    console.log(`wrote ${fixture.servedRecords.length} served records + ` +
        `${fixture.withheldOutpoints.length} withheld outpoint(s) to ${FIXTURE_PATH}`);
}

module.exports = { buildFixture, FIXTURE_PATH };

if (require.main === module) {
    main().catch((err) => { console.error(err); process.exit(1); });
}
