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

// Coinbase maturity was a single flat 100 for every chain, with a source comment
// asserting "consensus rule: 100 on BTC/LTC/DOGE". That is true for Bitcoin and
// Litecoin (COINBASE_MATURITY = 100 in consensus/consensus.h, every network) and
// false for Dogecoin, whose v1.14.9 chainparams.cpp carries nCoinbaseMaturity per
// consensus epoch: 240 on mainnet and testnet at the tip (the Digishield epoch
// from height 145000), and 60 on regtest. A DOGE coinbase at 150 confirmations
// was therefore served as spendable and could fund a PSBT the node rejects.
//
// These cases pin the per-chain numbers themselves, because a reversion to any
// flat constant is exactly the defect and every flat value passes a test that
// only checks the resolver returns some number.

const { expect } = require('chai');
const { resolveCoinbaseMaturity, DEFAULT_COINBASE_MATURITY } = require('../../src/coinbase-maturity');

describe('resolveCoinbaseMaturity', function () {

  const savedEnv = process.env.XCHAIN_COINBASE_MATURITY;
  afterEach(function () {
    if (savedEnv === undefined) delete process.env.XCHAIN_COINBASE_MATURITY;
    else process.env.XCHAIN_COINBASE_MATURITY = savedEnv;
  });

  describe('per-coin/network defaults', function () {
    it('Dogecoin mainnet and testnet resolve to 240, not the old flat 100', function () {
      expect(resolveCoinbaseMaturity('dogecoin-mainnet')).to.equal(240);
      expect(resolveCoinbaseMaturity('dogecoin-testnet')).to.equal(240);
    });

    it('Dogecoin regtest resolves to 60 (chainparams "easier testability" value)', function () {
      expect(resolveCoinbaseMaturity('dogecoin-regtest')).to.equal(60);
    });

    it('Bitcoin and Litecoin keep 100 on every network', function () {
      for (const net of ['mainnet', 'testnet', 'regtest']) {
        expect(resolveCoinbaseMaturity('bitcoin-' + net)).to.equal(100);
        expect(resolveCoinbaseMaturity('litecoin-' + net)).to.equal(100);
      }
    });

    it('no two chains share one flat value: DOGE mainnet differs from BTC mainnet', function () {
      expect(resolveCoinbaseMaturity('dogecoin-mainnet'))
        .to.not.equal(resolveCoinbaseMaturity('bitcoin-mainnet'));
    });
  });

  describe('refusals', function () {
    it('refuses a network no registered coin claims rather than defaulting', function () {
      expect(() => resolveCoinbaseMaturity('nosuchcoin-mainnet'))
        .to.throw(/names no coin in the canonical registry/);
    });

    it('refuses a registered coin with no declared maturity for that net', function () {
      // A bare full name carries no '-<net>' suffix, so it reaches the table with
      // an unresolvable net. It must refuse, not fall back to another net's value.
      expect(() => resolveCoinbaseMaturity('dogecoin'))
        .to.throw(/has no declared coinbase maturity/);
    });

    it('refuses BEFORE consulting an env override, so a bad chain cannot ride in on one', function () {
      process.env.XCHAIN_COINBASE_MATURITY = '5';
      expect(() => resolveCoinbaseMaturity('nosuchcoin-mainnet')).to.throw();
    });
  });

  describe('override resolution order', function () {
    it('an explicit positive integer opts value wins over the default', function () {
      expect(resolveCoinbaseMaturity('dogecoin-mainnet', 7)).to.equal(7);
    });

    it('a positive integer env override wins over the default', function () {
      process.env.XCHAIN_COINBASE_MATURITY = '3';
      expect(resolveCoinbaseMaturity('dogecoin-mainnet')).to.equal(3);
    });

    it('an explicit opts value wins over the env override', function () {
      process.env.XCHAIN_COINBASE_MATURITY = '3';
      expect(resolveCoinbaseMaturity('dogecoin-mainnet', 9)).to.equal(9);
    });

    it('a non-positive or non-integer env override falls back to the per-chain default', function () {
      for (const bad of ['0', '-5', 'abc', '']) {
        process.env.XCHAIN_COINBASE_MATURITY = bad;
        expect(resolveCoinbaseMaturity('dogecoin-mainnet')).to.equal(240);
      }
    });

    it('a non-positive or non-integer opts value falls back to the per-chain default', function () {
      for (const bad of [0, -5, 4.5, null, 'x']) {
        expect(resolveCoinbaseMaturity('bitcoin-mainnet', bad)).to.equal(100);
      }
    });
  });

  it('the exported table declares every net of every listed coin', function () {
    for (const coin of Object.keys(DEFAULT_COINBASE_MATURITY)) {
      for (const net of ['mainnet', 'testnet', 'regtest']) {
        expect(Number.isInteger(DEFAULT_COINBASE_MATURITY[coin][net]),
          coin + '.' + net + ' must declare an integer maturity').to.equal(true);
      }
    }
  });
});
