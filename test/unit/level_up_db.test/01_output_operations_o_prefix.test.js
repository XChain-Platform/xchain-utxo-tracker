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

const { expect } = require('chai');
const LevelUpStore = require('../../../src/store/level_up_db');
const crypto = require('crypto');

// Helper: generate a random 32-byte hex string (64 chars)
function randHash() {
  return crypto.randomBytes(32).toString('hex');
}
// Helper: generate a random 8-byte hex string (16 chars)
function randHash8() {
  return crypto.randomBytes(8).toString('hex');
}

let db;

function registerOutputStorageTests() {
  describe('output operations (O prefix)', function () {
    it('inserts and queries outputs by scriptPubKey', async function () {
      const scriptHash = randHash();
      const txHash8 = randHash8();
      await db.insertOutput({
        scriptPubKey: scriptHash,
        txHash: txHash8,
        outputIndex: 0,
        value: BigInt('100000000'),
        height: 500,
        fullTxHash: randHash()
      });
      await db.endTransaction(true);

      const outputs = await db.getOutputsScriptPubKey(scriptHash);
      expect(outputs).to.have.length(1);
      expect(outputs[0].txid).to.equal(txHash8);
      expect(outputs[0].vout).to.equal(0);
      expect(outputs[0].value).to.equal('100000000');
      expect(outputs[0].height).to.equal(500);
    });

    it('stores multiple outputs for the same scriptPubKey', async function () {
      const scriptHash = randHash();
      const tx1 = randHash8();
      const tx2 = randHash8();
      await db.insertOutput({ scriptPubKey: scriptHash, txHash: tx1, outputIndex: 0, value: BigInt(1000), height: 1 });
      await db.insertOutput({ scriptPubKey: scriptHash, txHash: tx2, outputIndex: 1, value: BigInt(2000), height: 2 });
      await db.endTransaction(true);

      const outputs = await db.getOutputsScriptPubKey(scriptHash);
      expect(outputs).to.have.length(2);
    });

    it('stores zero-value output', async function () {
      const scriptHash = randHash();
      await db.insertOutput({ scriptPubKey: scriptHash, txHash: randHash8(), outputIndex: 0, value: BigInt(0), height: 10 });
      await db.endTransaction(true);

      const outputs = await db.getOutputsScriptPubKey(scriptHash);
      expect(outputs[0].value).to.equal('0');
    });

    it('stores large Dogecoin-scale values', async function () {
      const scriptHash = randHash();
      const largeValue = BigInt('100000000000000'); // 1M DOGE in sats
      await db.insertOutput({ scriptPubKey: scriptHash, txHash: randHash8(), outputIndex: 0, value: largeValue, height: 1 });
      await db.endTransaction(true);

      const outputs = await db.getOutputsScriptPubKey(scriptHash);
      expect(outputs[0].value).to.equal('100000000000000');
    });

    it('returns empty for unknown scriptPubKey', async function () {
      const outputs = await db.getOutputsScriptPubKey(randHash());
      expect(outputs).to.be.empty;
    });
  });
}

function registerOutputIdentityTests() {
  describe('output operations (O prefix)', function () {
    it('fullTxid is null when not provided', async function () {
      const scriptHash = randHash();
      await db.insertOutput({ scriptPubKey: scriptHash, txHash: randHash8(), outputIndex: 0, value: BigInt(100), height: 1 });
      await db.endTransaction(true);

      const outputs = await db.getOutputsScriptPubKey(scriptHash);
      expect(outputs[0].fullTxid).to.be.null;
    });

    it('fullTxid is returned when provided', async function () {
      const scriptHash = randHash();
      const fullTxHash = randHash();
      await db.insertOutput({ scriptPubKey: scriptHash, txHash: randHash8(), outputIndex: 0, value: BigInt(100), height: 1, fullTxHash });
      await db.endTransaction(true);

      const outputs = await db.getOutputsScriptPubKey(scriptHash);
      expect(outputs[0].fullTxid).to.equal(fullTxHash);
    });

    // Regression guard: rangeEnd must append 12 bytes of 0xFF (commit
    // 6385686), not a single 0xFF byte, or the range scan in
    // getOutputsScriptPubKey treats an output whose txHash8 starts with
    // 0xFF as sorting past the upper bound and silently skips it. This
    // guards against accidental re-reverts during perf refactors of
    // LevelUpDb.js.
    it('returns outputs whose txHash8 starts with 0xFF (rangeEnd regression)', async function () {
      const scriptHash = randHash();
      const txFF = 'ff' + randHash8().substring(2); // first byte 0xFF
      const txNonFF = '00' + randHash8().substring(2); // first byte 0x00
      await db.insertOutput({ scriptPubKey: scriptHash, txHash: txFF, outputIndex: 0, value: BigInt(123), height: 1 });
      await db.insertOutput({ scriptPubKey: scriptHash, txHash: txNonFF, outputIndex: 0, value: BigInt(456), height: 2 });
      await db.endTransaction(true);

      const outputs = await db.getOutputsScriptPubKey(scriptHash);
      const txids = outputs.map(o => o.txid).sort();
      expect(txids).to.include(txFF);
      expect(txids).to.include(txNonFF);
      expect(outputs).to.have.length(2);
    });

    // Stronger variant: the txHash8 is ALL 0xFF bytes, exercising the worst
    // case for the rangeEnd upper bound. With a 1-byte 0xFF suffix this
    // returned []; with 12 bytes it returns the entry.
    it('returns outputs whose txHash8 is all 0xFF', async function () {
      const scriptHash = randHash();
      const txAllFF = 'ffffffffffffffff';
      await db.insertOutput({ scriptPubKey: scriptHash, txHash: txAllFF, outputIndex: 7, value: BigInt(789), height: 3 });
      await db.endTransaction(true);

      const outputs = await db.getOutputsScriptPubKey(scriptHash);
      expect(outputs).to.have.length(1);
      expect(outputs[0].txid).to.equal(txAllFF);
      expect(outputs[0].vout).to.equal(7);
    });
  });
}

function registerOutputPaginationStartTests() {
  describe('output operations (O prefix)', function () {
    // A mega miner-coinbase/payout address can hold millions of outputs.
    // Materializing them all OOMs the process; getOutputsScriptPubKey gained a
    // bounded page (limit + after cursor) and a fail-loud maxOutputs ceiling.
    describe('pagination + safety ceiling', function () {
      async function seed(scriptHash, n) {
        for (let i = 0; i < n; i++) {
          await db.insertOutput({ scriptPubKey: scriptHash, txHash: randHash8(), outputIndex: i % 3, value: BigInt(1000 + i), height: i + 1, fullTxHash: randHash() });
        }
        await db.endTransaction(true);
      }

      it('unbounded fetch with maxOutputs at/above the count does not throw', async function () {
        const scriptHash = randHash();
        await seed(scriptHash, 12);
        const out = await db.getOutputsScriptPubKey(scriptHash, { maxOutputs: 12 });
        expect(out).to.have.length(12);
      });

      it('maxOutputs below the count throws ADDRESS_TOO_LARGE', async function () {
        const scriptHash = randHash();
        await seed(scriptHash, 12);
        let err = null;
        try { await db.getOutputsScriptPubKey(scriptHash, { maxOutputs: 5 }); } catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.code).to.equal('ADDRESS_TOO_LARGE');
      });
    });
  });
}

function registerOutputPaginationTraversalTests() {
  describe('output operations (O prefix)', function () {
    describe('pagination + safety ceiling', function () {
      async function seed(scriptHash, n) {
        for (let i = 0; i < n; i++) {
          await db.insertOutput({ scriptPubKey: scriptHash, txHash: randHash8(), outputIndex: i % 3, value: BigInt(1000 + i), height: i + 1, fullTxHash: randHash() });
        }
        await db.endTransaction(true);
      }

      it('limit + after cursor pages the full set with no gaps, repeats, or reorder', async function () {
        const scriptHash = randHash();
        await seed(scriptHash, 23);
        const full = await db.getOutputsScriptPubKey(scriptHash);
        const fullKeys = full.map(o => o.txid + ':' + o.vout);

        const pageSize = 7;
        const collected = [];
        let after = null, guard = 0;
        while (guard++ < 100) {
          const page = await db.getOutputsScriptPubKey(scriptHash, { limit: pageSize, after });
          page.forEach(o => collected.push(o.txid + ':' + o.vout));
          if (page.length < pageSize) break;
          const last = page[page.length - 1];
          after = last.txid + ':' + last.vout;
        }
        expect(collected).to.deep.equal(fullKeys);
        expect(new Set(collected).size).to.equal(23);
      });
    });
  });
}

function registerOutputPaginationValidationTests() {
  describe('output operations (O prefix)', function () {
    describe('pagination + safety ceiling', function () {
      async function seed(scriptHash, n) {
        for (let i = 0; i < n; i++) {
          await db.insertOutput({ scriptPubKey: scriptHash, txHash: randHash8(), outputIndex: i % 3, value: BigInt(1000 + i), height: i + 1, fullTxHash: randHash() });
        }
        await db.endTransaction(true);
      }

      it('a bounded page ignores the maxOutputs ceiling', async function () {
        const scriptHash = randHash();
        await seed(scriptHash, 12);
        const page = await db.getOutputsScriptPubKey(scriptHash, { limit: 3, maxOutputs: 1 });
        expect(page).to.have.length(3);
      });

      it('a malformed cursor throws INVALID_CURSOR', async function () {
        const scriptHash = randHash();
        await seed(scriptHash, 3);
        let err = null;
        try { await db.getOutputsScriptPubKey(scriptHash, { limit: 2, after: 'not-a-cursor' }); } catch (e) { err = e; }
        expect(err).to.be.an('error');
        expect(err.code).to.equal('INVALID_CURSOR');
      });
    });
  });
}

describe('LevelUpDb', function () {
  beforeEach(async function () {
    db = new LevelUpStore('test-' + Date.now(), true); // in-memory
    await db.createDatabase();
  });

  afterEach(async function () {
    try { await db.close(); } catch (e) { /* already closed */ }
  });

  registerOutputStorageTests();
  registerOutputIdentityTests();
  registerOutputPaginationStartTests();
  registerOutputPaginationTraversalTests();
  registerOutputPaginationValidationTests();
});
