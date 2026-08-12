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

// Production-scale latency contract for the tracker's address scan and for
// the paged drain the encoder does before coin selection. A separate fuzz
// suite proves the key schema is CORRECT at scale (no collisions, no
// aliasing across prefixes); this proves it is FAST at scale, a different
// failure mode with the same symptom surface. Every query here is a
// prefix-range read whose cost must be O(rows returned), independent of how
// many rows the store holds; a regression that makes it O(store) - a dropped
// gte/lte bound, a full-iterator filter, a key layout that no longer
// clusters an address's outputs - passes every correctness test and takes
// the tracker down on launch day.
//
// So the assertions come in pairs: the EXACT result set (compared against a
// plan computed without touching the database) and a WALL-CLOCK ceiling. A fast
// wrong answer and a slow right answer both fail.
//
// The point-probe budgets are deliberately flat across scale tiers. That is the
// whole regression signal: reading one address's single UTXO out of a 20k-row
// store and out of a 40M-row store must cost the same, so the same number holds
// at every tier and only an algorithmic regression can break it.
//
// Scale tiers (UTXO_PERF_DB_SCALE, default `ci`):
//   ci       ~32k UTXOs / 20k scripts     - the default, ~1 min, runs in the lane
//   medium   ~525k UTXOs / 250k scripts
//   large    ~6M UTXOs / 2M scripts
//   mainnet  ~40M UTXOs / 5M scripts      - BTC-mainnet order of magnitude,
//                                           needs ~15 GB of disk, ~1 h to build
//
// Run the mainnet tier before a cohort bootstrap:
//   UTXO_PERF_DB_SCALE=mainnet UTXO_PERF_DB_DIR=/big/disk npm run test:perf:mainnet

const assert = require('assert');
const { generateStore, closeStore, resolveTier } = require('./mainnetScaleDb');

// The page size xchain-encoder's UtxoTracker client uses when it drains an
// address before coin selection; matching it keeps the measured shape honest.
const ENCODER_PAGE_LIMIT = 10000;

// A slow shared CI box can legitimately need more headroom than a workstation.
const BUDGET_X = Number(process.env.UTXO_PERF_BUDGET_MULTIPLIER) > 0
    ? Number(process.env.UTXO_PERF_BUDGET_MULTIPLIER)
    : 1;

// Flat, scale-independent ceilings (ms, median of SAMPLES).
const POINT_SCAN_BUDGET_MS   = 150 * BUDGET_X;  // address holding a single UTXO
const SMALL_SCAN_BUDGET_MS   = 200 * BUDGET_X;  // ordinary wallet, 8 UTXOs
const BALANCE_BUDGET_MS      = 250 * BUDGET_X;  // same scan + per-output mempool probe
const ABSENT_SCAN_BUDGET_MS  = 100 * BUDGET_X;  // prefix with no rows at all

// The drain is the one budget that scales, because it genuinely returns more
// rows at a bigger tier. Expressed as a throughput floor so the ceiling grows
// linearly with the work, not with the store.
const DRAIN_MIN_UTXOS_PER_SEC = 1000 / BUDGET_X;
const DRAIN_FLOOR_MS          = 4000 * BUDGET_X;

const SAMPLES = 15;
const WARMUP  = 3;

function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Time `fn` SAMPLES times after WARMUP discarded runs, validating every sample.
// Validation inside the loop is what stops a fast error path (an exception, an
// empty array from a broken bound) from sneaking under a latency ceiling.
async function measure(fn, validate) {
    for (let i = 0; i < WARMUP; i++) validate(await fn());
    const samples = [];
    for (let i = 0; i < SAMPLES; i++) {
        const t = process.hrtime.bigint();
        const result = await fn();
        samples.push(Number(process.hrtime.bigint() - t) / 1e6);
        validate(result);
    }
    return { medianMs: median(samples), maxMs: Math.max(...samples), samples };
}

// Assert a returned UTXO array matches the plan element-for-element. Compares
// the fields a spend depends on, not a stringified blob, so a failure names the
// field that drifted.
function assertUtxosMatchPlan(actual, expected, tipHeight, scriptHex, label) {
    assert.strictEqual(actual.length, expected.length,
        `${label}: expected exactly ${expected.length} UTXOs, got ${actual.length}`);
    for (let i = 0; i < expected.length; i++) {
        const a = actual[i];
        const e = expected[i];
        assert.strictEqual(a.txid, e.fullTxid, `${label}[${i}]: txid`);
        assert.strictEqual(a.vout, e.vout, `${label}[${i}]: vout`);
        assert.strictEqual(String(a.value), String(e.value), `${label}[${i}]: value`);
        assert.strictEqual(a.height, e.height, `${label}[${i}]: height`);
        assert.strictEqual(a.coinbase, false, `${label}[${i}]: coinbase flag`);
        assert.strictEqual(a.confirmations, tipHeight - e.height + 1, `${label}[${i}]: confirmations`);
        assert.strictEqual(a.scriptPubKey, scriptHex, `${label}[${i}]: scriptPubKey`);
    }
}

// Drain an address exactly the way xchain-encoder's tracker client does: fixed
// page limit, thread nextCursor into `after`, stop when the tracker stops
// handing one back. Returns the concatenated rows plus the page count so the
// test can assert the drain took the expected number of round trips.
async function drainPaged(tracker, address, pageLimit) {
    const all = [];
    let after;
    let pages = 0;
    for (;;) {
        pages++;
        const opts = { limit: pageLimit };
        if (after !== undefined) opts.after = after;
        const page = await tracker.getUtxosAddress(address, opts);
        all.push(...page);
        const next = page.nextCursor;
        if (!next) break;
        after = next;
        if (pages > 1000) throw new Error('pagination did not terminate');
    }
    return { utxos: all, pages };
}

// The encoder's selection shape: value-descending, then accumulate until the
// target is covered. Values arrive as decimal strings, so compare as BigInt -
// a lexicographic sort would put '9' above '100000'.
function selectCoins(utxos, targetSats) {
    const sorted = [...utxos].sort((a, b) => {
        const av = BigInt(a.value);
        const bv = BigInt(b.value);
        return av < bv ? 1 : av > bv ? -1 : 0;
    });
    const selected = [];
    let total = 0n;
    for (const u of sorted) {
        selected.push(u);
        total += BigInt(u.value);
        if (total >= targetSats) break;
    }
    return { selected, total };
}

describe('Performance: production-scale LevelDB address scan + coin selection', function () {
    this.timeout(0);

    let built;
    let plan;
    const tier = resolveTier();

    before(async function () {
        const t0 = Date.now();
        built = await generateStore({
            tier,
            onProgress: ({ written, total }) => {
                // Silent for the default tier; a mainnet build takes long enough
                // that no output reads as a hang.
                if (total > 1000000 && written % 1000000 === 0) {
                    process.stdout.write(`      [scale-db] ${written}/${total} UTXOs written\n`);
                }
            }
        });
        plan = built.plan;
        process.stdout.write(
            `      [scale-db] tier=${tier.name} utxos=${built.stats.utxosWritten}` +
            ` scripts=${tier.fillerScripts + 4}` +
            ` disk=${(built.stats.bytesOnDisk / 1024 / 1024).toFixed(1)}MB` +
            ` build=${((Date.now() - t0) / 1000).toFixed(1)}s\n`
        );
    });

    after(async function () {
        await closeStore(built, { keep: process.env.UTXO_PERF_KEEP_DB === '1' });
    });

    it('the generated store really is at the requested scale', function () {
        assert.strictEqual(built.stats.utxosWritten, plan.totalUtxoCount,
            'generator wrote a different number of UTXOs than it planned');
        assert.ok(built.stats.bytesOnDisk > 0, 'store should exist on disk, not in memory');
    });

    it('scans an address holding one UTXO in flat time, with the exact UTXO', async function () {
        const probe = plan.probes.dust;
        const { medianMs, maxMs } = await measure(
            () => built.tracker.getUtxosAddress(probe.address),
            (utxos) => assertUtxosMatchPlan(utxos, probe.utxos, plan.tipHeight, probe.scriptHex, 'dust')
        );
        process.stdout.write(`      [dust scan] median=${medianMs.toFixed(2)}ms max=${maxMs.toFixed(2)}ms\n`);
        assert.ok(medianMs < POINT_SCAN_BUDGET_MS,
            `single-UTXO address scan median ${medianMs.toFixed(2)}ms exceeded ${POINT_SCAN_BUDGET_MS}ms ` +
            `at tier ${tier.name} (${plan.totalUtxoCount} UTXOs): the scan is no longer O(rows returned)`);
    });

    it('scans an ordinary wallet in flat time, with the exact UTXO set in key order', async function () {
        const probe = plan.probes.small;
        const { medianMs, maxMs } = await measure(
            () => built.tracker.getUtxosAddress(probe.address),
            (utxos) => assertUtxosMatchPlan(utxos, probe.utxos, plan.tipHeight, probe.scriptHex, 'small')
        );
        process.stdout.write(`      [small scan] median=${medianMs.toFixed(2)}ms max=${maxMs.toFixed(2)}ms\n`);
        assert.ok(medianMs < SMALL_SCAN_BUDGET_MS,
            `8-UTXO address scan median ${medianMs.toFixed(2)}ms exceeded ${SMALL_SCAN_BUDGET_MS}ms at tier ${tier.name}`);
    });

    it('returns an empty result for an address with no rows, without walking the store', async function () {
        const probe = plan.probes.empty;
        const { medianMs, maxMs } = await measure(
            () => built.tracker.getUtxosAddress(probe.address),
            (utxos) => assert.strictEqual(utxos.length, 0, 'unfunded address must return no UTXOs')
        );
        process.stdout.write(`      [absent scan] median=${medianMs.toFixed(2)}ms max=${maxMs.toFixed(2)}ms\n`);
        // The sharpest probe in the file: a missing prefix costs one seek if the
        // range bounds are right and a full store walk if they are not.
        assert.ok(medianMs < ABSENT_SCAN_BUDGET_MS,
            `absent-address scan median ${medianMs.toFixed(2)}ms exceeded ${ABSENT_SCAN_BUDGET_MS}ms at tier ${tier.name}: ` +
            `an unfunded address is walking rows it should never touch`);
    });

    it('reports the exact balance for an ordinary wallet inside budget', async function () {
        const probe = plan.probes.small;
        const expectedSats = probe.utxos.reduce((acc, u) => acc + BigInt(u.value), 0n);
        const expected = (expectedSats / 100000000n).toString() + '.' +
            (expectedSats % 100000000n).toString().padStart(8, '0');

        const { medianMs, maxMs } = await measure(
            () => built.tracker.getBalanceInfo(probe.address),
            (info) => {
                assert.strictEqual(info.balances.confirmed, expected, 'confirmed balance');
                assert.strictEqual(info.balances.pending, '0.00000000', 'pending balance');
                assert.strictEqual(info.utxos.confirmed, probe.utxos.length, 'confirmed UTXO count');
                assert.strictEqual(info.utxos.pending, 0, 'pending UTXO count');
            }
        );
        process.stdout.write(`      [balance] median=${medianMs.toFixed(2)}ms max=${maxMs.toFixed(2)}ms\n`);
        assert.ok(medianMs < BALANCE_BUDGET_MS,
            `get_info median ${medianMs.toFixed(2)}ms exceeded ${BALANCE_BUDGET_MS}ms at tier ${tier.name}`);
    });

    it('drains a whale address page by page with no gaps, no repeats, inside a throughput floor', async function () {
        const probe = plan.probes.whale;
        const expectedPages = Math.floor(probe.utxos.length / ENCODER_PAGE_LIMIT) + 1;
        const budgetMs = Math.max(DRAIN_FLOOR_MS, (probe.utxos.length / DRAIN_MIN_UTXOS_PER_SEC) * 1000);

        const t = process.hrtime.bigint();
        const { utxos, pages } = await drainPaged(built.tracker, probe.address, ENCODER_PAGE_LIMIT);
        const elapsedMs = Number(process.hrtime.bigint() - t) / 1e6;

        process.stdout.write(
            `      [whale drain] ${utxos.length} UTXOs in ${pages} pages, ${elapsedMs.toFixed(0)}ms ` +
            `(${(utxos.length / (elapsedMs / 1000)).toFixed(0)}/s)\n`
        );

        assertUtxosMatchPlan(utxos, probe.utxos, plan.tipHeight, probe.scriptHex, 'whale');

        // Every outpoint distinct: a cursor that repeats a row hands the encoder
        // a duplicate input and the built PSBT is rejected by the node.
        const seen = new Set(utxos.map(u => u.txid + ':' + u.vout));
        assert.strictEqual(seen.size, utxos.length, 'paged drain returned a duplicate outpoint');

        assert.strictEqual(pages, expectedPages,
            `expected ${expectedPages} pages at limit ${ENCODER_PAGE_LIMIT}, got ${pages}`);
        assert.ok(elapsedMs < budgetMs,
            `whale drain took ${elapsedMs.toFixed(0)}ms, over the ${budgetMs.toFixed(0)}ms budget ` +
            `for ${probe.utxos.length} UTXOs at tier ${tier.name}`);
    });

    it('a paged drain returns exactly what one unpaged scan returns', async function () {
        const probe = plan.probes.whale;
        const unpaged = await built.tracker.getUtxosAddress(probe.address);
        const { utxos: paged } = await drainPaged(built.tracker, probe.address, ENCODER_PAGE_LIMIT);

        assert.strictEqual(paged.length, unpaged.length, 'paged and unpaged counts differ');
        for (let i = 0; i < unpaged.length; i++) {
            assert.strictEqual(paged[i].txid + ':' + paged[i].vout, unpaged[i].txid + ':' + unpaged[i].vout,
                `paged and unpaged disagree at index ${i}`);
        }
    });

    it('selects the exact coins the encoder would, inside budget', async function () {
        const probe = plan.probes.whale;

        // Expected answer computed from the PLAN, not from the query result:
        // top five values by amount, and a target that provably needs all five
        // (one satoshi above the top four) and no more.
        const byValueDesc = [...probe.utxos].sort((a, b) => b.value - a.value);
        const topFive = byValueDesc.slice(0, 5);
        const topFour = topFive.slice(0, 4).reduce((acc, u) => acc + BigInt(u.value), 0n);
        const target = topFour + 1n;
        const expectedTotal = topFive.reduce((acc, u) => acc + BigInt(u.value), 0n);

        const budgetMs = Math.max(DRAIN_FLOOR_MS, (probe.utxos.length / DRAIN_MIN_UTXOS_PER_SEC) * 1000) + 2000;

        const t = process.hrtime.bigint();
        const { utxos } = await drainPaged(built.tracker, probe.address, ENCODER_PAGE_LIMIT);
        const { selected, total } = selectCoins(utxos, target);
        const elapsedMs = Number(process.hrtime.bigint() - t) / 1e6;

        process.stdout.write(`      [coin selection] ${selected.length} inputs from ${utxos.length} UTXOs in ${elapsedMs.toFixed(0)}ms\n`);

        assert.strictEqual(selected.length, 5,
            `expected exactly 5 inputs for a target of ${target}, got ${selected.length}`);
        assert.strictEqual(total, expectedTotal, 'selected total does not match the top five by value');
        for (let i = 0; i < 5; i++) {
            assert.strictEqual(selected[i].txid, topFive[i].fullTxid, `selected input ${i} is not the expected outpoint`);
            assert.strictEqual(selected[i].vout, topFive[i].vout, `selected input ${i} vout`);
        }
        assert.ok(elapsedMs < budgetMs,
            `drain + coin selection took ${elapsedMs.toFixed(0)}ms, over the ${budgetMs.toFixed(0)}ms budget at tier ${tier.name}`);
    });

    it('resumes from a mid-set cursor without gaps or repeats', async function () {
        const probe = plan.probes.whale;
        const half = Math.floor(probe.utxos.length / 2);

        const firstPage = await built.tracker.getUtxosAddress(probe.address, { limit: half });
        assert.strictEqual(firstPage.length, half, 'first page should be exactly the requested size');
        assert.ok(firstPage.nextCursor, 'a full page must hand back a continuation cursor');

        const rest = await built.tracker.getUtxosAddress(probe.address,
            { limit: probe.utxos.length, after: firstPage.nextCursor });

        const combined = [...firstPage, ...rest];
        assertUtxosMatchPlan(combined, probe.utxos, plan.tipHeight, probe.scriptHex, 'cursor-resume');
    });
});
