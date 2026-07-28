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

// Generator for a production-scale, ON-DISK tracker LevelDB ( leg a).
//
// Why this exists: every other perf harness in this repo builds its store by
// replaying synthetic BLOCKS, which caps out in the low hundreds of thousands
// of outputs before the block-decode path, not the key schema, dominates the
// clock. BTC mainnet is tens of millions of UTXOs spread over millions of
// distinct scriptPubKeys, and the two queries launch week hits first (the
// address scan and the paged drain the encoder does before coin selection) are
// prefix-range reads whose cost must stay O(page) no matter how large the store
// gets. A key-schema or iterator-option regression that turns either into an
// O(store) walk is invisible at 200k rows and fatal at 40M.
//
// So this generator writes the REAL records through the REAL write path
// (LevelUpStore.insertOutput / insertOutputHint / insertOutputBlock inside the
// store's own batched transactions), just without paying for block decode. The
// bytes on disk are byte-identical to what a synced tracker would hold; only
// the route that put them there is shorter.
//
// What is deliberately NOT written: the S/Z first-seen script index and the
// K/M reorg-recovery records. Neither is read by the scan or coin-selection
// paths under test, and both would roughly double generation cost for a
// mainnet-tier run. getFirstSeen is therefore out of scope for this harness.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createHash } = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const ECPairFactory = require('ecpair');
const ecc = require('tiny-secp256k1');
const { ClassicLevel } = require('classic-level');

const LevelUpStore = require('../../src/LevelUpDb');
const XChainUtxoTracker = require('../../src/XChainUtxoTracker');

const ECPair = ECPairFactory.ECPairFactory(ecc);
const NETWORK = bitcoin.networks.regtest;

// ─── Scale tiers ─────────────────────────────────────────────────────────────
//
// `fillerScripts` distinct scriptPubKeys each hold `utxosPerFiller` outputs;
// they exist only to make the O-keyspace big, so the probe scans below have to
// find their prefix inside a realistically sized store. The probe addresses
// carry the exactly-known sets every assertion is made against.
//
// The default tier is `ci`: small enough that `npm run test:perf` stays a
// couple of minutes, large enough that a linear-scan regression blows the
// budget. The `mainnet` tier is the one the ledger item asks for (tens of
// millions of UTXOs, millions of scripts); it is opt-in because it needs
// roughly 15 GB of disk and the better part of an hour to build.
const SCALE_TIERS = {
    ci:      { fillerScripts:    20000, utxosPerFiller: 1, whaleUtxos:  12000 },
    medium:  { fillerScripts:   250000, utxosPerFiller: 2, whaleUtxos:  25000 },
    large:   { fillerScripts:  2000000, utxosPerFiller: 3, whaleUtxos:  60000 },
    // ~40M UTXOs over 5M distinct scriptPubKeys: BTC-mainnet order of magnitude.
    mainnet: { fillerScripts:  5000000, utxosPerFiller: 8, whaleUtxos: 250000 }
};

// The sibling perf files in this directory are driven by PERF_SCALE
// (small/medium/large, wired to test:perf:quick / test:perf:deep). Honour it as
// a fallback so `npm run test:perf:deep` scales THIS file too instead of
// silently running it at the default tier, while UTXO_PERF_DB_SCALE stays the
// direct control and is the only way to reach the `mainnet` tier.
const PERF_SCALE_ALIAS = { small: 'ci', medium: 'medium', large: 'large' };

function resolveTier() {
    const name = process.env.UTXO_PERF_DB_SCALE
        || PERF_SCALE_ALIAS[process.env.PERF_SCALE]
        || 'ci';
    const tier = SCALE_TIERS[name];
    if (!tier) {
        throw new Error(
            `unknown UTXO_PERF_DB_SCALE '${name}' (expected one of ${Object.keys(SCALE_TIERS).join(', ')})`
        );
    }
    return { name, ...tier };
}

// ─── Probe plan ──────────────────────────────────────────────────────────────
//
// Four probe addresses with exactly-known holdings, chosen to cover the shapes
// the assertions care about:
//   dust   1 UTXO      - the point-lookup shape (one row behind a 32-byte prefix)
//   small  8 UTXOs     - a normal wallet, single unpaged read
//   whale  N UTXOs     - the multi-page drain the encoder does before selection
//   empty  0 UTXOs     - an address with no prefix in the store at all
const PROBE_NAMES = ['dust', 'small', 'whale', 'empty'];

function deriveProbeKey(name) {
    const privKey = createHash('sha256').update('xchain-perf-probe:' + name).digest();
    const keyPair = ECPair.fromPrivateKey(privKey, { network: NETWORK });
    const p2pkh = bitcoin.payments.p2pkh({ pubkey: keyPair.publicKey, network: NETWORK });
    const script = bitcoin.address.toOutputScript(p2pkh.address, NETWORK);
    return {
        name,
        address: p2pkh.address,
        script,
        scriptHash: createHash('sha256').update(script).digest('hex'),
        scriptHex: script.toString('hex')
    };
}

// Deterministic 32-byte txid for global output ordinal `i`. The O key carries
// only the first 8 bytes, so the full hash also lands in the O VALUE (the
// tracker fails loud on a record without one); both come from here.
function txidFor(i) {
    return createHash('sha256').update('xchain-perf-tx:' + i).digest('hex');
}

// Deterministic 32-byte filler scriptPubKey hash. Filler rows never need a real
// address: the store keys outputs by the sha256 of the script, and nothing in
// the scan path re-derives the script from it.
function fillerScriptHash(i) {
    return createHash('sha256').update('xchain-perf-spk:' + i).digest('hex');
}

// Distinct, strictly increasing values so a value-descending sort has exactly
// one correct answer and the coin-selection assertion can name it.
function probeValueFor(ordinal) {
    return 100000 + ordinal * 13;
}

/**
 * Build the deterministic plan for a tier: which outputs each probe address
 * holds, in the order the store will return them (O keys sort by
 * [scriptHash][txHash8][vout], i.e. by the 8-byte txid prefix).
 *
 * Computed WITHOUT touching the database so the expectations are independent of
 * the code under test: if the store's key schema changed, the plan would not
 * change with it, and the exact-result assertions would fail as they should.
 */
function buildPlan(tier) {
    const probes = {};
    let ordinal = 0;

    const counts = { dust: 1, small: 8, whale: tier.whaleUtxos, empty: 0 };

    for (const name of PROBE_NAMES) {
        const key = deriveProbeKey(name);
        const utxos = [];
        for (let i = 0; i < counts[name]; i++) {
            const fullTxid = txidFor(ordinal);
            utxos.push({
                fullTxid,
                txHash8: fullTxid.slice(0, 16),
                vout: i % 4,
                value: probeValueFor(ordinal),
                // Heights walk a plausible mainnet range; every probe output is
                // non-coinbase so the maturity gate never withholds one and the
                // expected sets stay exact.
                height: 700000 + (ordinal % 100000),
                coinbase: false
            });
            ordinal++;
        }
        // The store returns a prefix range in key order, which is ascending by
        // the 8-byte txid prefix then vout. Mirror that here so a returned array
        // can be compared element-by-element, not just as a set.
        utxos.sort((a, b) => (a.txHash8 < b.txHash8 ? -1 : a.txHash8 > b.txHash8 ? 1 : a.vout - b.vout));
        probes[name] = { ...key, utxos };
    }

    return {
        tier,
        probes,
        // Tip height: far enough above every planted height that confirmations
        // are positive and stable for the whole run.
        tipHeight: 900000,
        fillerUtxoCount: tier.fillerScripts * tier.utxosPerFiller,
        probeUtxoCount: ordinal,
        totalUtxoCount: tier.fillerScripts * tier.utxosPerFiller + ordinal
    };
}

// ─── Store construction ──────────────────────────────────────────────────────

// A LevelUpStore whose createDatabase opens an on-disk classic-level in `dir`
// instead of the hard-coded /data/<name> production path. Everything else is
// the shipped store: same key builders, same batching, same iterators.
function makeOnDiskStore(name, dir, opts = {}) {
    const store = new LevelUpStore(name, false);
    store.createDatabase = async function () {
        this.db = new ClassicLevel(dir, {
            keyEncoding: 'buffer',
            valueEncoding: 'buffer',
            // Modest and EXPLICIT, unlike the 4 GB production default: a perf
            // budget met only because the whole store fits in cache would prove
            // nothing about a real node, and the default would OOM a laptop.
            cacheSize: opts.cacheBytes || 64 * 1024 * 1024,
            writeBufferSize: opts.writeBufferBytes || 64 * 1024 * 1024
        });
        await this.db.open();
        return this.db;
    };
    return store;
}

/**
 * Generate the store on disk and return { tracker, plan, dir, stats }.
 *
 * `onProgress({ written, total })` is called every flush so a long mainnet-tier
 * build reports rather than looking hung.
 */
async function generateStore({ tier, dir, batchUtxos = 50000, onProgress = null } = {}) {
    const resolved = tier || resolveTier();
    const plan = buildPlan(resolved);

    const dbDir = dir || fs.mkdtempSync(path.join(
        process.env.UTXO_PERF_DB_DIR || os.tmpdir(), 'xchain-perf-scale-'
    ));

    // knownScripts is a process-global existence cache on the class; a stale one
    // from an earlier suite in the same mocha process would make the (skipped)
    // S/Z path lie. Reset for hygiene even though this generator does not use it.
    LevelUpStore.knownScripts = new Set();

    const db = makeOnDiskStore('perf-scale-confirmed', dbDir);
    await db.createDatabase();

    // The mempool store stays in-memory and empty, exactly as a synced tracker
    // with a quiet mempool: getUtxosAddress still probes it for every result, so
    // the harness measures that probe too rather than stubbing it away.
    const mempoolDb = new LevelUpStore('perf-scale-mempool', true);
    await mempoolDb.createDatabase();

    const startedAt = Date.now();
    let written = 0;

    await db.beginTransaction();
    let staged = 0;

    const flush = async () => {
        await db.endTransaction(true);
        await db.beginTransaction();
        staged = 0;
        if (onProgress) onProgress({ written, total: plan.totalUtxoCount });
    };

    // A single synthetic block hash owns every W (creation-block) record. Real
    // stores spread these over millions of blocks, but W is never read by the
    // scan path; it is written only so the store's byte volume and compaction
    // behaviour match a real one.
    const blockHash = createHash('sha256').update('xchain-perf-block').digest('hex');

    const put = async (scriptHashHex, fullTxid, vout, value, height, coinbase) => {
        const output = {
            scriptPubKey: scriptHashHex,
            txHash: fullTxid.slice(0, 16),
            fullTxHash: fullTxid,
            outputIndex: vout,
            value,
            height,
            coinbase,
            blockHash
        };
        await db.insertOutput(output);
        await db.insertOutputHint(output);
        await db.insertOutputBlock(output);
        written++;
        staged++;
        if (staged >= batchUtxos) await flush();
    };

    // Probe rows first, so even an interrupted large build has them.
    for (const name of PROBE_NAMES) {
        const probe = plan.probes[name];
        for (const u of probe.utxos) {
            await put(probe.scriptHash, u.fullTxid, u.vout, u.value, u.height, u.coinbase);
        }
    }

    // Filler: the bulk of the keyspace.
    let fillerOrdinal = plan.probeUtxoCount;
    for (let s = 0; s < resolved.fillerScripts; s++) {
        const sh = fillerScriptHash(s);
        for (let k = 0; k < resolved.utxosPerFiller; k++) {
            const fullTxid = txidFor(fillerOrdinal);
            await put(sh, fullTxid, k, 50000 + (fillerOrdinal % 90000), 400000 + (fillerOrdinal % 300000), false);
            fillerOrdinal++;
        }
    }

    await db.setLastBlockHeight(plan.tipHeight);
    await db.endTransaction(true);

    const generateMs = Date.now() - startedAt;

    // A real tracker instance, wired to the generated store. The constructor
    // does no I/O, so this exercises the shipped query methods rather than a
    // re-implementation of them.
    const tracker = new XChainUtxoTracker(
        'bitcoin-regtest', '127.0.0.1', '18443', 'user', 'pass', 'perf-scale-db', false
    );
    tracker.db = db;
    tracker.mempoolDb = mempoolDb;
    tracker.blockchainInfoLastBlock = plan.tipHeight;

    return {
        tracker,
        plan,
        dir: dbDir,
        stats: { generateMs, utxosWritten: written, bytesOnDisk: dirSize(dbDir) }
    };
}

function dirSize(dir) {
    let total = 0;
    try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, entry.name);
            total += entry.isDirectory() ? dirSize(p) : fs.statSync(p).size;
        }
    } catch (e) { /* best-effort reporting only */ }
    return total;
}

async function closeStore(built, { keep = false } = {}) {
    if (!built) return;
    try { await built.tracker.db.close(); } catch (e) { /* already closed */ }
    try { await built.tracker.mempoolDb.close(); } catch (e) { /* already closed */ }
    if (!keep) {
        try { fs.rmSync(built.dir, { recursive: true, force: true }); } catch (e) { /* best effort */ }
    }
}

module.exports = {
    SCALE_TIERS,
    PROBE_NAMES,
    resolveTier,
    buildPlan,
    deriveProbeKey,
    generateStore,
    closeStore,
    makeOnDiskStore,
    dirSize
};
