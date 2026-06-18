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

// ─── Regression: satoshiToDecimalString must stay exact-integer, never float ──
//
// Commit a2774ac reintroduced (and was reverted from) a float-based amount
// formatter (`Number(sats) / 1e8` then toFixed(8)). For any satoshi count above
// 2**53 that division loses the low digits, so a balance can be misreported by
// one or more satoshi. The current source uses BigInt. These tests reproduce a
// value where the naive float path provably diverges, and assert the source
// returns the exact decimal, so a silent reversion to float fails here.

const { expect } = require('chai');
const { satoshiToDecimalString } = require('../../src/XChainUtxoTracker');

// The naive (buggy) implementation, kept ONLY to prove these inputs actually
// expose the float error (i.e. the regression test is not vacuous).
function naiveFloat(sats) {
  return (Number(sats) / 1e8).toFixed(8);
}

describe('Regression (a2774ac): exact-integer satoshi formatting', function () {

  // Each entry is a value whose naive float formatting is WRONG.
  const divergent = [
    '9007199254740993',    // 2**53 + 1: first integer Number can't represent
    '90071992547409930',   // ×10, still beyond float's integer range
    '2099999997690000001', // > max BTC supply in sats, +1 (sub-sat sensitive)
    '18446744073709551615', // uint64 max
  ];

  divergent.forEach((sats) => {
    it(`formats ${sats} exactly (and the float path would be wrong)`, function () {
      const exact = satoshiToDecimalString(sats);

      // Recompute the expected string with pure BigInt arithmetic, independent
      // of the source, to cross-check.
      const v = BigInt(sats);
      const whole = v / 100000000n;
      const frac = (v % 100000000n).toString().padStart(8, '0');
      const expected = `${whole}.${frac}`;
      expect(exact).to.equal(expected);

      // Guard-of-the-guard: confirm the naive float path really differs, so this
      // test genuinely catches a reversion rather than passing for both impls.
      expect(naiveFloat(sats)).to.not.equal(exact);
    });
  });

  it('the off-by-one above 2**53 is preserved (90071992.54740993, not ...992)', function () {
    expect(satoshiToDecimalString('9007199254740993')).to.equal('90071992.54740993');
    // The float path rounds the trailing 3 down to a 2 (the exact symptom).
    expect(naiveFloat('9007199254740993')).to.equal('90071992.54740992');
  });

  it('accepts BigInt, number, and string forms identically for in-range values', function () {
    expect(satoshiToDecimalString(150000000)).to.equal('1.50000000');
    expect(satoshiToDecimalString(150000000n)).to.equal('1.50000000');
    expect(satoshiToDecimalString('150000000')).to.equal('1.50000000');
  });

  it('preserves the sign and magnitude of negative balances (pending outflows)', function () {
    // pendingBalance can go negative when confirmed outputs are spent in the
    // mempool. The formatter takes the absolute value for the digits and
    // re-prepends '-', so both the sign branch and the abs() must hold.
    expect(satoshiToDecimalString(-150000000)).to.equal('-1.50000000');
    expect(satoshiToDecimalString(-1)).to.equal('-0.00000001');
    expect(satoshiToDecimalString(-150000000n)).to.equal('-1.50000000');
    // Above 2**53, so the magnitude path is exact-integer, not float.
    expect(satoshiToDecimalString('-9007199254740993')).to.equal('-90071992.54740993');
  });
});
