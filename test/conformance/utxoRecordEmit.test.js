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
// PRODUCER half of the shared UTXO-record conformance fixture. Re-runs the real
// emit path (getUtxosAddress over a real LevelDB store fed by the real
// block-parse passes) and requires it to still produce the pinned golden
// records byte for byte.
//
// This is the guard the seam never had. The record shape is re-exported
// verbatim over the encoder's public get_utxos JSON-RPC and read from there by
// xchain-sdk (published to npm with the field set written into its docstring),
// xchain-hub, xchain-e2e-test and, through the SDK, xchain-wallet - so a rename
// or a unit change here escapes to external integrators via a package release.
// Until this file, the only thing pinning it on this side was a prose comment
// in test/boundary/confirmations.test.js.
//
// The CONSUMER half lives in xchain-encoder
// (test/conformance/utxoRecordConformance.test.js) over a vendored
// byte-identical copy of the same JSON.

const assert = require('assert');
const fs = require('fs');
const { buildFixture, FIXTURE_PATH } = require('./generateUtxoRecordFixture.js');

const golden = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));

describe('utxo-record conformance fixture: the tracker still emits the pinned records', function () {
    this.timeout(60000);

    let live;

    before(async function () {
        live = await buildFixture();
    });

    it('serves the same records, field for field', function () {
        assert.deepStrictEqual(live.servedRecords, golden.servedRecords);
    });

    it('withholds the same outpoints', function () {
        assert.deepStrictEqual(live.withheldOutpoints, golden.withheldOutpoints);
    });

    it('carries the same freshness sibling shape', function () {
        assert.deepStrictEqual(live.sync, golden.sync);
    });

    it('the checked-in artifact is byte-identical to a fresh generation', function () {
        // Regenerating must be a no-op. If it is not, the fixture on disk was
        // hand-edited or the emit path moved, and either way the consumer half
        // is now pinning something the tracker does not produce.
        assert.strictEqual(
            JSON.stringify(live, null, 2) + '\n',
            fs.readFileSync(FIXTURE_PATH, 'utf8'),
            'test/fixtures/utxo-record-conformance.json is stale; re-run ' +
            'node test/conformance/generateUtxoRecordFixture.js and re-vendor the xchain-encoder copy'
        );
    });

    describe('the contract each field carries', function () {
        it('value is satoshis as an exact decimal string, never a JS Number', function () {
            for (const r of golden.servedRecords) {
                assert.strictEqual(typeof r.value, 'string', `${r.txid}: value must be a decimal string`);
                assert.ok(/^\d+$/.test(r.value), `${r.txid}: value must be digits only`);
            }
        });

        it('covers a value above 2^53-1 satoshis, which is why value is a string', function () {
            const big = golden.servedRecords.find((r) => BigInt(r.value) > BigInt(Number.MAX_SAFE_INTEGER));
            assert.ok(big, 'no record exceeds MAX_SAFE_INTEGER; the case the string type exists for is gone');
            // The negative this case is the control for: parsing it as a Number
            // silently loses the low digit, which is the whole failure mode.
            assert.notStrictEqual(String(Number(big.value)), big.value,
                'the big-value case no longer demonstrates Number precision loss');
        });

        it('amount is the coin-denominated sibling of value, never the spendable field', function () {
            for (const r of golden.servedRecords) {
                assert.ok(/^\d+\.\d{8}$/.test(r.amount), `${r.txid}: amount must be a fixed-8 decimal string`);
                const fromValue = (BigInt(r.value) / 100000000n).toString() + '.' +
                    (BigInt(r.value) % 100000000n).toString().padStart(8, '0');
                assert.strictEqual(r.amount, fromValue, `${r.txid}: amount must be derived from value`);
            }
        });

        it('txid is the full 64-hex hash, never the 16-hex key prefix', function () {
            for (const r of golden.servedRecords) {
                assert.ok(/^[0-9a-f]{64}$/.test(r.txid), `${r.txid}: txid must be 64 lowercase hex chars`);
            }
        });

        it('covers a mempool record: height null, confirmations 0', function () {
            const mempool = golden.servedRecords.filter((r) => r.height === null);
            assert.strictEqual(mempool.length, 1, 'exactly one mempool record is pinned');
            assert.strictEqual(mempool[0].confirmations, 0);
        });

        it('covers a mature coinbase record and withholds the immature one', function () {
            const coinbase = golden.servedRecords.filter((r) => r.coinbase === true);
            assert.strictEqual(coinbase.length, 1, 'exactly one mature coinbase record is pinned');
            assert.ok(coinbase[0].confirmations >= golden.tip.coinbaseMaturity,
                'the served coinbase record must be mature');
            assert.strictEqual(golden.withheldOutpoints.length, 1);
            const withheldKey = golden.withheldOutpoints[0].txid + ':' + golden.withheldOutpoints[0].vout;
            const servedKeys = golden.servedRecords.map((r) => r.txid + ':' + r.vout);
            assert.ok(!servedKeys.includes(withheldKey),
                'the immature coinbase outpoint must not appear in the served list');
        });

        it('scriptPubKey is non-empty even-length hex on every record', function () {
            for (const r of golden.servedRecords) {
                assert.ok(/^([0-9a-f]{2})+$/.test(r.scriptPubKey),
                    `${r.txid}: scriptPubKey must be even-length lowercase hex`);
            }
        });
    });
});
