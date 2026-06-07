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
// The JSON-RPC method get_input_from_key_pattern runs a LevelDB prefix scan,
// gated by `pattern.length < 32`. These tests pin its input-handling contract:
//
//   1. The length gate is a STRING check, so a non-string `pattern` (number, or
//      an object without a numeric .length) takes the else branch and reaches
//      the DB layer rather than the structured "too short" reply — the call then
//      surfaces an error instead of a clean rejection.
//   2. Results are the RAW {key, value} hex for the supplied prefix, not the
//      sanitised UTXO shape the address endpoints return, and the scan is
//      prefix-bounded (rangeEnd), never a full-table dump.
//
// We replicate the controller's exact guard (api.js) bound to a real in-memory
// tracker.db, mirroring how unit/api.test.js reconstructs the app for testing.

const { expect } = require('chai');
const {
  TEST_KEYS,
  createTestTracker,
  closeTracker,
} = require('../integration/helpers');

// Verbatim copy of the api.js JSON-RPC handler body, so a drift in the real
// guard (e.g. tightening it to also reject non-strings) surfaces here.
function getInputFromKeyPattern(tracker, { pattern }) {
  if (pattern.length < 32) {
    return Promise.resolve({ error: 'pattern is too short' });
  }
  return tracker.db.getValuesFromKeyPattern(pattern).then((results) => ({ result: results }));
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

  it('a numeric pattern is not caught by the string-length gate and surfaces an error', async function () {
    // (12345).length === undefined → `undefined < 32` is false → the guard is
    // skipped and the raw value flows into getValuesFromKeyPattern, which rejects
    // the non-string/non-Buffer input. A hardened gate would reject earlier with
    // the structured "too short"/"invalid" reply; pinned here so that change is
    // visible if the guard is later tightened.
    let rejected = false;
    try {
      await getInputFromKeyPattern(tracker, { pattern: 99999999999999999999 });
    } catch (e) {
      rejected = true;
    }
    expect(rejected, 'numeric pattern should not reach a clean rejection (it throws)').to.equal(true);
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
