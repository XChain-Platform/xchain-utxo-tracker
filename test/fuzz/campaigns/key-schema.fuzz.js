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

// Property-based key-schema fuzz over mainnet-scale key distributions .
//
// Extends test/unit/key-schema-invariant.test.js, which pins the schema
// invariants against FIXED sample keys. Mainnet exercises key-space edges
// regtest never reaches: BTC has millions of scriptPubKey hashes, so sort-
// adjacent hashes, long shared prefixes, all-0xFF / all-0x00 tail runs, and
// interior bytes that collide with the prefix-family alphabet all occur in
// practice. A key-schema or rangeEnd miss on those edges silently drops or
// fabricates UTXOs in encoder coin-selection (2 prior live bugs in this
// defect class). Here fast-check drives adversarial key distributions
// through the builder registry, rangeEnd, and REAL LevelDB range scans and
// asserts exact-set behavior: every inserted key is returned, and no key
// from a sort-adjacent family or neighbor ever bleeds in.

const { expect } = require('chai');
const { fc, FUZZ_RUNS, arbBuffer, randHash, randHash8 } = require('../helpers');
const LevelUpStore = require('../../../src/LevelUpDb');

const MAX_KEY_LEN = 77;   // K/P_OUT_DEL, the longest key in the schema

// ─── Adversarial arbitraries (mainnet-scale distributions) ───────────────────

// 32-byte hash with mainnet edge shapes: uniform, all-0x00, all-0xFF,
// 0xFF/0x00 tail runs of arbitrary length (sort-boundary shapes), and bytes
// drawn from the key-prefix alphabet 0x42-0x5A so interior bytes mimic
// family prefixes.
function arbHash32Buf() {
  return fc.oneof(
    { weight: 3, arbitrary: arbBuffer(32) },
    fc.constant(Buffer.alloc(32, 0x00)),
    fc.constant(Buffer.alloc(32, 0xFF)),
    fc.tuple(arbBuffer(32), fc.integer({ min: 1, max: 32 }), fc.constantFrom(0x00, 0xFF))
      .map(([b, k, fill]) => { const c = Buffer.from(b); c.fill(fill, 32 - k); return c; }),
    fc.uint8Array({ minLength: 32, maxLength: 32 })
      .map((a) => Buffer.from(Array.from(a, (x) => 0x42 + (x % 0x19))))
  );
}
function arbHash32() { return arbHash32Buf().map((b) => b.toString('hex')); }

// 8-byte txid prefix including sort-extreme shapes.
function arbHash8() {
  return fc.oneof(
    { weight: 3, arbitrary: arbBuffer(8).map((b) => b.toString('hex')) },
    fc.constant('00'.repeat(8)),
    fc.constant('ff'.repeat(8)),
    fc.tuple(arbBuffer(8), fc.integer({ min: 1, max: 8 }))
      .map(([b, k]) => { const c = Buffer.from(b); c.fill(0xFF, 8 - k); return c.toString('hex'); })
  );
}

// vout with the boundary values that stress the 4-byte big-endian encoding.
function arbVout() {
  return fc.oneof(
    fc.constantFrom(0, 1, 0xFFFFFFFE, 0xFFFFFFFF),
    fc.integer({ min: 0, max: 0xFFFFFFFF })
  );
}

// Big-endian increment/decrement of a buffer copy (null on wrap-around).
// Produces the sort-adjacent neighbor hashes a mainnet-scale key space
// contains but a few-address regtest run never does.
function bufStep(buf, delta) {
  const c = Buffer.from(buf);
  for (let i = c.length - 1; i >= 0; i--) {
    const v = c[i] + delta;
    if (v >= 0 && v <= 0xFF) { c[i] = v; return c; }
    c[i] = v < 0 ? 0xFF : 0x00;
  }
  return null; // wrapped past all-0x00 / all-0xFF
}

async function freshDb() {
  const d = new LevelUpStore('fuzz-key-schema-' + Date.now() + '-' + Math.random(), true);
  await d.createDatabase();
  return d;
}

describe('Fuzz: key-schema over mainnet-scale distributions ', function () {

  // ─── 1. Builder field round-trip under adversarial inputs ─────────────────

  describe('builder field round-trip', function () {
    it('kOutput embeds scriptHash/txHash8/vout byte-exactly for any input shape', function () {
      fc.assert(
        fc.property(arbHash32(), arbHash8(), arbVout(), (script, tx8, vout) => {
          const key = LevelUpStore.kOutput(script, tx8, vout);
          expect(key.length).to.equal(45);
          expect(key[0]).to.equal(0x4F);
          expect(key.slice(1, 33).toString('hex')).to.equal(script);
          expect(key.slice(33, 41).toString('hex')).to.equal(tx8);
          expect(key.readUInt32BE(41)).to.equal(vout);
        }),
        { numRuns: FUZZ_RUNS }
      );
    });

    it('kOutDel embeds blockHash/scriptHash/txHash8/vout byte-exactly for any input shape', function () {
      fc.assert(
        fc.property(arbHash32(), arbHash32(), arbHash8(), arbVout(), (blk, script, tx8, vout) => {
          const key = LevelUpStore.kOutDel(blk, script, tx8, vout);
          expect(key.length).to.equal(77);
          expect(key[0]).to.equal(0x4B);
          expect(key.slice(1, 33).toString('hex')).to.equal(blk);
          expect(key.slice(33, 65).toString('hex')).to.equal(script);
          expect(key.slice(65, 73).toString('hex')).to.equal(tx8);
          expect(key.readUInt32BE(73)).to.equal(vout);
        }),
        { numRuns: FUZZ_RUNS }
      );
    });

    it('hex and Buffer builder pairs stay byte-identical for any input shape', function () {
      fc.assert(
        fc.property(arbHash32Buf(), arbHash32(), arbHash8(), arbVout(), (scriptBuf, blk, tx8, vout) => {
          const script = scriptBuf.toString('hex');
          expect(LevelUpStore.kOutputFromBuf(scriptBuf, tx8, vout)
            .equals(LevelUpStore.kOutput(script, tx8, vout))).to.equal(true);
          expect(LevelUpStore.kOutDelFromBuf(blk, scriptBuf, tx8, vout)
            .equals(LevelUpStore.kOutDel(blk, script, tx8, vout))).to.equal(true);
          expect(LevelUpStore.kScriptBlkFromBuf(scriptBuf)
            .equals(LevelUpStore.kScriptBlk(script))).to.equal(true);
          expect(LevelUpStore.kBlkScriptFromBuf(blk, scriptBuf)
            .equals(LevelUpStore.kBlkScript(blk, script))).to.equal(true);
        }),
        { numRuns: FUZZ_RUNS }
      );
    });
  });

  // ─── 2. rangeEnd is an exact bound: membership iff prefix match ───────────

  describe('rangeEnd exactness', function () {
    // For any prefix (2..77 bytes) and any key up to the schema max length:
    // the key sorts inside [prefix, rangeEnd(prefix)] IF AND ONLY IF it
    // starts with the prefix. The "if" direction failing is the twice-fixed
    // dropped-key bug; the "only if" direction failing fabricates rows from
    // a neighboring family into a scan.
    it('a key sorts within [prefix, rangeEnd(prefix)] iff it starts with the prefix', function () {
      const arbKey = fc.tuple(
        fc.integer({ min: 2, max: MAX_KEY_LEN }),
        arbHash32Buf(), arbHash32Buf(), arbBuffer(13)
      ).map(([len, a, b, c]) => Buffer.concat([a, b, c]).slice(0, len));

      fc.assert(
        fc.property(
          arbKey,
          fc.integer({ min: 2, max: MAX_KEY_LEN }),
          fc.boolean(),
          fc.integer({ min: 1, max: MAX_KEY_LEN - 1 }),
          (key, prefixLen, usePrefixOfKey, fillLen) => {
            // Half the runs test a true prefix of the key (possibly extended
            // with worst-case 0xFF suffix); half test an arbitrary prefix.
            let prefix;
            let testKey = key;
            if (usePrefixOfKey) {
              prefix = key.slice(0, Math.min(prefixLen, key.length));
              // worst-case member: prefix + all-0xFF suffix up to max key len
              const suffix = Buffer.alloc(Math.min(fillLen, MAX_KEY_LEN - prefix.length), 0xFF);
              testKey = Buffer.concat([prefix, suffix]);
            } else {
              prefix = bufStep(key.slice(0, Math.min(prefixLen, key.length)), 1);
              if (prefix === null) return; // wrapped; skip
            }
            const inRange =
              Buffer.compare(testKey, prefix) >= 0 &&
              Buffer.compare(testKey, LevelUpStore.rangeEnd(prefix)) <= 0;
            const isPrefix =
              testKey.length >= prefix.length &&
              testKey.slice(0, prefix.length).equals(prefix);
            expect(inRange, `membership mismatch for prefix ${prefix.toString('hex')} key ${testKey.toString('hex')}`)
              .to.equal(isPrefix);
          }
        ),
        { numRuns: FUZZ_RUNS }
      );
    });

    it('sort-adjacent prefixes (prefix +/- 1) never fall inside the range', function () {
      fc.assert(
        fc.property(arbHash32Buf(), fc.integer({ min: 2, max: 33 }), (h, len) => {
          const prefix = Buffer.concat([Buffer.from([0x4F]), h]).slice(0, len);
          const bound = LevelUpStore.rangeEnd(prefix);
          for (const delta of [1, -1]) {
            const neighbor = bufStep(prefix, delta);
            if (neighbor === null) continue;
            // A key under the NEIGHBOR prefix with worst-case suffix must sort
            // strictly outside [prefix, bound].
            const worst = Buffer.concat([
              neighbor,
              Buffer.alloc(MAX_KEY_LEN - neighbor.length, delta === 1 ? 0x00 : 0xFF)
            ]);
            const inside = Buffer.compare(worst, prefix) >= 0 && Buffer.compare(worst, bound) <= 0;
            expect(inside, `neighbor ${neighbor.toString('hex')} bleeds into range of ${prefix.toString('hex')}`)
              .to.equal(false);
          }
        }),
        { numRuns: FUZZ_RUNS }
      );
    });
  });

  // ─── 3. Real-DB scan exactness over sort-adjacent scriptHash clusters ─────

  describe('range-scan exactness on a real DB', function () {
    // Insert outputs under a cluster of sort-adjacent scriptHashes (the
    // base hash, its +1/-1 neighbors, and its 0xFF-tail variant), the shape
    // a mainnet-scale key space produces. Each per-script scan must return
    // EXACTLY its own outputs: any drop is the encoder-facing lost-UTXO bug,
    // any extra row is a fabricated UTXO from a neighbor address.
    it('getOutputsScriptPubKey returns the exact inserted set for every cluster member', async function () {
      await fc.assert(
        fc.asyncProperty(
          arbHash32Buf(),
          fc.integer({ min: 1, max: 6 }),
          async (baseBuf, perScript) => {
            const cluster = new Map();  // scriptHex -> expected Set("tx8:vout")
            const candidates = [baseBuf, bufStep(baseBuf, 1), bufStep(baseBuf, -1)];
            const ffTail = Buffer.from(baseBuf); ffTail.fill(0xFF, 24);
            candidates.push(ffTail);
            for (const c of candidates) {
              if (c) cluster.set(c.toString('hex'), new Set());
            }

            const db = await freshDb();
            try {
              await db.beginTransaction();
              for (const [scriptHex, expected] of cluster) {
                for (let i = 0; i < perScript; i++) {
                  // include vout boundary values in every cluster
                  const vout = i === 0 ? 0xFFFFFFFF : i;
                  const tx8 = i === 1 ? 'ff'.repeat(8) : randHash8();
                  const entry = tx8 + ':' + vout;
                  if (expected.has(entry)) continue;
                  expected.add(entry);
                  await db.insertOutput({
                    scriptPubKey: scriptHex,
                    txHash: tx8,
                    outputIndex: vout,
                    value: BigInt(i + 1),
                    height: 100 + i,
                    fullTxHash: tx8 + randHash().substring(16)
                  });
                }
              }
              await db.endTransaction(true);

              for (const [scriptHex, expected] of cluster) {
                const rows = await db.getOutputsScriptPubKey(scriptHex);
                const got = new Set(rows.map((r) => r.txid + ':' + r.vout));
                expect(got, `scan for ${scriptHex} returned wrong set`).to.deep.equal(expected);
              }
            } finally {
              try { await db.close(); } catch (e) {}
            }
          }
        ),
        { numRuns: Math.min(FUZZ_RUNS, 150) }
      );
    });

    it('getValuesFromKeyPattern returns exactly the keys matching the pattern', async function () {
      await fc.assert(
        fc.asyncProperty(
          arbHash32Buf(),
          fc.integer({ min: 2, max: 32 }),
          fc.integer({ min: 2, max: 5 }),
          async (baseBuf, patternHashBytes, perScript) => {
            // Population: base, sort-adjacent neighbors, and a variant that
            // shares exactly (patternHashBytes - 1) leading hash bytes, so the
            // pattern boundary itself is contested.
            const scripts = [baseBuf, bufStep(baseBuf, 1), bufStep(baseBuf, -1)]
              .filter(Boolean);
            const divergent = Buffer.from(baseBuf);
            divergent[patternHashBytes - 1] ^= 0x01;
            scripts.push(divergent);

            const db = await freshDb();
            const insertedKeys = new Set();
            try {
              await db.beginTransaction();
              for (const s of scripts) {
                const scriptHex = s.toString('hex');
                for (let i = 0; i < perScript; i++) {
                  const tx8 = randHash8();
                  const vout = i === 0 ? 0xFFFFFFFF : i;
                  await db.insertOutput({
                    scriptPubKey: scriptHex,
                    txHash: tx8,
                    outputIndex: vout,
                    value: 1n,
                    height: 1,
                    fullTxHash: tx8 + randHash().substring(16)
                  });
                  insertedKeys.add(LevelUpStore.kOutput(scriptHex, tx8, vout).toString('hex'));
                }
              }
              await db.endTransaction(true);

              // Pattern: O prefix + first patternHashBytes of the base hash.
              const pattern = Buffer.concat([
                Buffer.from([0x4F]),
                baseBuf.slice(0, patternHashBytes)
              ]).toString('hex');

              const rows = await db.getValuesFromKeyPattern(pattern);
              const got = new Set(rows.map((r) => r.key));
              const expected = new Set(
                [...insertedKeys].filter((k) => k.startsWith(pattern))
              );
              expect(got, `pattern ${pattern} scan returned wrong key set`).to.deep.equal(expected);
            } finally {
              try { await db.close(); } catch (e) {}
            }
          }
        ),
        { numRuns: Math.min(FUZZ_RUNS, 150) }
      );
    });
  });
});
