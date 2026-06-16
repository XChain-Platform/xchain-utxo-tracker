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

// ─── Boundary: range-scan upper bound at a maximal (all-0xFF) key suffix ───────
//
// rangeEnd(prefix) caps a prefix scan with `prefix + 12 bytes of 0xFF`. The
// source comment (LevelUpDb.js) records that a *single* 0xFF byte is wrong —
// LevelDB's lexicographic compare ranks a longer key as greater than a shorter
// upper bound, so a record whose suffix is itself all-0xFF sorts ABOVE a 1-byte
// 0xFF cap and silently vanishes from the scan. That exact regression landed
// (39696e8) and was later reverted (a2774ac).
//
// The existing unit/boundary "all-ff scriptHash prefix" case only stores
// outputIndex 0 (suffix = txHash8 + 00000000), so it never exercises a maximal
// suffix. Here the suffix bytes after the 33-byte O-prefix are themselves all
// 0xFF (txHash8 = ff..ff, outputIndex = 0xFFFFFFFF) — the precise shape that a
// too-short upper bound would drop.

const { expect } = require('chai');
const LevelUpStore = require('../../src/LevelUpDb');

const FF_TXID8 = 'ff'.repeat(8);          // 8-byte O-key txHash8, all 0xFF
const MAX_VOUT = 0xFFFFFFFF;              // 4-byte outputIndex, all 0xFF
const FF_FULLTXID = 'ff'.repeat(32);      // 64-hex full txid

describe('Boundary: range-scan with maximal 0xFF key suffix', function () {
  let db;

  beforeEach(async function () {
    db = new LevelUpStore('boundary-ffscan-' + Date.now() + '-' + Math.random(), true);
    await db.createDatabase();
  });

  afterEach(async function () {
    try { await db.close(); } catch (e) {}
  });

  it('returns an output whose entire key suffix is 0xFF (12-byte cap, not 1-byte)', async function () {
    // scriptHash deliberately NOT all-0xFF so only the SUFFIX stresses rangeEnd.
    const scriptHash = 'aa'.repeat(32);

    await db.beginTransaction();
    await db.insertOutput({
      scriptPubKey: scriptHash,
      txHash: FF_TXID8,
      outputIndex: MAX_VOUT,
      value: 123456789,
      height: 7,
      fullTxHash: FF_FULLTXID,
    });
    await db.endTransaction();

    const outputs = await db.getOutputsScriptPubKey(scriptHash);
    expect(outputs).to.have.length(1);
    expect(outputs[0].txid).to.equal(FF_TXID8);
    expect(outputs[0].vout).to.equal(MAX_VOUT);   // would be missing under a 1-byte cap
    expect(outputs[0].value).to.equal('123456789');
  });

  it('the 0xFF-suffix cap does not bleed into the adjacent (incremented) scriptHash', async function () {
    // A = ...aa, B = ...ab (last byte +1). A's 12-byte 0xFF upper bound must still
    // sort below B's prefix, so scanning A never returns B's record.
    const scriptHashA = 'aa'.repeat(32);
    const scriptHashB = 'aa'.repeat(31) + 'ab';

    await db.beginTransaction();
    await db.insertOutput({
      scriptPubKey: scriptHashA, txHash: FF_TXID8, outputIndex: MAX_VOUT,
      value: 111, height: 1, fullTxHash: FF_FULLTXID,
    });
    await db.insertOutput({
      scriptPubKey: scriptHashB, txHash: '00'.repeat(8), outputIndex: 0,
      value: 222, height: 1, fullTxHash: '00'.repeat(32),
    });
    await db.endTransaction();

    const a = await db.getOutputsScriptPubKey(scriptHashA);
    expect(a).to.have.length(1);
    expect(a[0].value).to.equal('111');

    const b = await db.getOutputsScriptPubKey(scriptHashB);
    expect(b).to.have.length(1);
    expect(b[0].value).to.equal('222');
  });

  it('multiple vouts under one scriptHash all survive when the top vout is 0xFFFFFFFF', async function () {
    const scriptHash = 'cd'.repeat(32);

    await db.beginTransaction();
    for (const idx of [0, 1, 0x7FFFFFFF, MAX_VOUT]) {
      await db.insertOutput({
        scriptPubKey: scriptHash, txHash: FF_TXID8, outputIndex: idx,
        value: 1000 + idx, height: 2, fullTxHash: FF_FULLTXID,
      });
    }
    await db.endTransaction();

    const outputs = await db.getOutputsScriptPubKey(scriptHash);
    const vouts = outputs.map((o) => o.vout).sort((x, y) => x - y);
    expect(vouts).to.deep.equal([0, 1, 0x7FFFFFFF, MAX_VOUT]);
  });
});

describe('Boundary: getValuesFromKeyPattern hex-decode + inclusive bounds', function () {
  let db;

  beforeEach(async function () {
    db = new LevelUpStore('boundary-pattern-' + Date.now() + '-' + Math.random(), true);
    await db.createDatabase();
  });

  afterEach(async function () {
    try { await db.close(); } catch (e) {}
  });

  it('a pattern that decodes below the 2-byte prefix floor is refused', async function () {
    // h2b() is Buffer.from(hex,'hex'); Node drops a dangling nibble, so a
    // single nibble decodes to an EMPTY buffer — whose scan range would cover
    // the entire database. The method must fail loud, not scan.
    let err = null;
    try {
      await db.getValuesFromKeyPattern('a'); // single nibble → empty buffer prefix
    } catch (e) {
      err = e;
    }
    expect(err).to.be.an('error');
    expect(err.code).to.equal('BAD_REQUEST');
  });

  it('odd-length hex above the floor truncates the trailing nibble rather than throwing', async function () {
    // A dangling nibble on an otherwise-valid prefix degrades to the
    // even-length prefix; the scan must not crash and must stay prefix-scoped.
    const scriptHash = 'be'.repeat(32);
    await db.beginTransaction();
    await db.insertOutput({ scriptPubKey: scriptHash, txHash: '11'.repeat(8), outputIndex: 0, value: 5, height: 1, fullTxHash: '11'.repeat(32) });
    await db.endTransaction();

    const rows = await db.getValuesFromKeyPattern('4f' + scriptHash + 'a');
    expect(rows).to.be.an('array').with.length(1);
  });

  it('returns rows at the exact prefix and is inclusive of the upper bound', async function () {
    // Store two outputs whose O-keys share a 33-byte prefix, then pattern-scan
    // by the hex of that prefix and confirm both rows come back.
    const scriptHash = 'be'.repeat(32);
    await db.beginTransaction();
    await db.insertOutput({ scriptPubKey: scriptHash, txHash: '11'.repeat(8), outputIndex: 0, value: 5, height: 1, fullTxHash: '11'.repeat(32) });
    await db.insertOutput({ scriptPubKey: scriptHash, txHash: 'ff'.repeat(8), outputIndex: MAX_VOUT, value: 6, height: 1, fullTxHash: FF_FULLTXID });
    await db.endTransaction();

    // O prefix byte is 0x4F ('O'); build [4F][scriptHash] as hex.
    const prefixHex = '4f' + scriptHash;
    const rows = await db.getValuesFromKeyPattern(prefixHex);
    expect(rows.length).to.equal(2);
  });
});
