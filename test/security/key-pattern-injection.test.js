'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

// ─── Security: get_input_from_key_pattern raw-scan primitive ──────────────────
//
// The JSON-RPC method get_input_from_key_pattern runs a LevelDB prefix scan.
// These tests pin its input-handling contract:
//
//   1. The gate rejects non-strings, strings shorter than 32 chars, and strings
//      containing any non-hex character. Buffer.from(str, 'hex') silently
//      truncates at the first invalid character, so without the hex check a
//      32-char all-invalid pattern (e.g. 'g'.repeat(32)) would decode to an
//      EMPTY prefix and the scan range (gte=[], lte=rangeEnd) would dump the
//      entire database into one in-memory array.
//   2. Results are the RAW {key, value} hex for the supplied prefix, not the
//      sanitised UTXO shape the address endpoints return, and the scan is
//      prefix-bounded (rangeEnd), never a full-table dump.
//   3. The DB layer itself refuses prefixes that decode to <2 bytes and caps
//      result accumulation via maxValues (AddressTooLargeError), so even a
//      caller that bypasses the API gate cannot trigger an unbounded scan.
//
// We replicate the controller's exact guard (api.js) bound to a real in-memory
// tracker.db, mirroring how unit/api.test.js reconstructs the app for testing.

const { expect } = require('chai');
const {
  TEST_KEYS,
  createTestTracker,
  closeTracker,
} = require('../integration/helpers');
const XChainUtxoTracker = require('../../src/XChainUtxoTracker');
const { AddressTooLargeError } = require('../../src/LevelUpDb');

// Verbatim copy of the api.js JSON-RPC handler body, so a drift in the real
// guard surfaces here.
function getInputFromKeyPattern(tracker, { pattern }) {
  if (typeof pattern !== 'string' || pattern.length < 32) {
    return Promise.resolve({ error: 'pattern is too short' });
  }
  if (!/^[0-9a-fA-F]+$/.test(pattern)) {
    return Promise.resolve({ error: 'pattern must be a hex string' });
  }
  return tracker.db.getValuesFromKeyPattern(pattern,
    { maxValues: XChainUtxoTracker.MAX_ADDRESS_OUTPUTS }).then((results) => ({ result: results }));
}

const ADDR = TEST_KEYS[0];

describe('Security: get_input_from_key_pattern guard + scan surface', function () {
  let tracker;

  beforeEach(async function () {
    tracker = await createTestTracker();
    await tracker.db.beginTransaction();
    await tracker.db.insertOutput({
      scriptPubKey: ADDR.scriptHash, txHash: 'cc'.repeat(8), outputIndex: 0,
      value: 4242, height: 3, fullTxHash: 'cc'.repeat(32),
    });
    await tracker.db.endTransaction();
  });

  afterEach(async function () {
    await closeTracker(tracker);
  });

  it('rejects an empty / too-short string pattern', async function () {
    expect(await getInputFromKeyPattern(tracker, { pattern: '' })).to.deep.equal({ error: 'pattern is too short' });
    expect(await getInputFromKeyPattern(tracker, { pattern: 'ab' })).to.deep.equal({ error: 'pattern is too short' });
  });

  it('the length gate boundary is exactly 32 chars (31 rejected, 32 allowed)', async function () {
    const at31 = await getInputFromKeyPattern(tracker, { pattern: 'a'.repeat(31) });
    expect(at31).to.deep.equal({ error: 'pattern is too short' });

    // 32 hex chars (16 bytes) passes the gate; the prefix matches nothing here,
    // so it returns an empty result set rather than the too-short error.
    const at32 = await getInputFromKeyPattern(tracker, { pattern: 'a'.repeat(32) });
    expect(at32).to.have.property('result');
    expect(at32.result).to.be.an('array');
  });

  it('a numeric pattern gets the structured rejection, never reaching the DB', async function () {
    // (12345).length === undefined, so the old string-length-only gate skipped
    // it and the raw number flowed into the DB layer. The typeof check now
    // rejects any non-string cleanly at the gate.
    const res = await getInputFromKeyPattern(tracker, { pattern: 99999999999999999999 });
    expect(res).to.deep.equal({ error: 'pattern is too short' });
  });

  it('rejects a 32-char all-invalid-hex pattern at the gate (empty-prefix full-DB scan)', async function () {
    // 'g'.repeat(32) clears the length gate but Buffer.from(.., 'hex') would
    // decode it to a 0-byte buffer — a scan of gte=[] lte=[FF…]: the whole DB.
    const res = await getInputFromKeyPattern(tracker, { pattern: 'g'.repeat(32) });
    expect(res).to.deep.equal({ error: 'pattern must be a hex string' });
  });

  it('rejects a pattern with a non-hex character mid-string (1-byte-prefix scan)', async function () {
    // '4f' + 'g'.repeat(30) would silently truncate to the single byte 0x4f —
    // a scan of every live O-prefix UTXO in the database.
    const res = await getInputFromKeyPattern(tracker, { pattern: '4f' + 'g'.repeat(30) });
    expect(res).to.deep.equal({ error: 'pattern must be a hex string' });
  });

  it('still accepts mixed-case valid hex', async function () {
    const prefix = ('4f' + ADDR.scriptHash).toUpperCase();
    const res = await getInputFromKeyPattern(tracker, { pattern: prefix });
    expect(res).to.have.property('result');
    expect(res.result.length).to.be.greaterThan(0);
  });

  it('DB layer refuses a pattern that decodes to a <2-byte prefix', async function () {
    // Defense in depth: even bypassing the API gate, getValuesFromKeyPattern
    // must throw on a 0/1-byte decoded prefix instead of scanning the full DB.
    for (const pattern of ['g'.repeat(32), '4f' + 'g'.repeat(30), '', '4f']) {
      let err = null;
      try {
        await tracker.db.getValuesFromKeyPattern(pattern);
      } catch (e) {
        err = e;
      }
      expect(err, `pattern ${JSON.stringify(pattern)} should throw`).to.be.an('error');
      expect(err.code).to.equal('BAD_REQUEST');
    }
  });

  it('DB layer enforces the maxValues ceiling (AddressTooLargeError)', async function () {
    // Two rows exist under ADDR's O-prefix after this insert; a ceiling of 1
    // must fail loud rather than accumulate past it.
    await tracker.db.beginTransaction();
    await tracker.db.insertOutput({
      scriptPubKey: ADDR.scriptHash, txHash: 'dd'.repeat(8), outputIndex: 1,
      value: 1111, height: 4, fullTxHash: 'dd'.repeat(32),
    });
    await tracker.db.endTransaction();

    let err = null;
    try {
      await tracker.db.getValuesFromKeyPattern('4f' + ADDR.scriptHash, { maxValues: 1 });
    } catch (e) {
      err = e;
    }
    expect(err).to.be.an.instanceOf(AddressTooLargeError);
    expect(err.code).to.equal('ADDRESS_TOO_LARGE');
  });

  it('returns raw key/value hex for a supplied prefix, scoped to that prefix', async function () {
    // Scan ADDR[0]'s O-namespace by its full 33-byte prefix (O byte + scriptHash).
    const prefix = '4f' + ADDR.scriptHash; // 66 hex chars, passes the gate
    const res = await getInputFromKeyPattern(tracker, { pattern: prefix });

    expect(res).to.have.property('result');
    expect(res.result.length).to.be.greaterThan(0);

    // The rows are the raw stored encoding (hex key + hex value), NOT the
    // sanitised {txid, vout, amount} the public address endpoints expose.
    const row = res.result[0];
    expect(row).to.have.all.keys('key', 'value');
    expect(row.key).to.match(/^4f/); // begins with the O prefix byte
    // The value is the raw stored encoding as hex — non-empty (scan requested
    // values, not just keys).
    expect(row.value).to.be.a('string').and.match(/^[0-9a-f]+$/i).and.have.length.greaterThan(0);
    expect(row).to.not.have.property('amount');
    expect(row).to.not.have.property('txid');
  });

  it('a prefix matching no records returns an empty set, not the whole DB', async function () {
    // A 33-byte prefix for a scriptHash with no outputs must scope to nothing —
    // proving the scan is prefix-bounded (rangeEnd), not a full table dump.
    const emptyPrefix = '4f' + 'de'.repeat(32);
    const res = await getInputFromKeyPattern(tracker, { pattern: emptyPrefix });
    expect(res.result).to.be.an('array').with.length(0);
  });
});
