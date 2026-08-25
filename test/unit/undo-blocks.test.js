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

// resolveUndoBlocks previously short-circuited on a truthy optsUndoBlocks
// before running the integer/positive validation or the MAX_SAFE ceiling
// warning that the env path applies, so resolveUndoBlocks(network, -5) fell
// through and returned -5 outright (a negative undo-blocks window degenerates
// the aging loop into a mass undo purge), and a non-integer opts value went
// unvalidated too. The fix routes the explicit opts value through the same
// integer/positive check as the env override, falling back to the per-chain
// default on an invalid value, and applies the MAX_SAFE_UNDO_BLOCKS ceiling
// warning uniformly regardless of which path produced the value.

const { expect } = require('chai');
const sinon = require('sinon');
const { resolveUndoBlocks, DEFAULT_UNDO_BLOCKS, MAX_SAFE_UNDO_BLOCKS } = require('../../src/undo-blocks');

describe('resolveUndoBlocks opts validation', function () {
  let consoleErrorStub;

  beforeEach(function () {
    consoleErrorStub = sinon.stub(console, 'error');
  });

  afterEach(function () {
    consoleErrorStub.restore();
  });

  it('falls back to the per-chain default when optsUndoBlocks is negative', function () {
    expect(resolveUndoBlocks('dogecoin-mainnet', -5)).to.equal(DEFAULT_UNDO_BLOCKS.DOGE);
  });

  it('falls back to the per-chain default when optsUndoBlocks is zero', function () {
    expect(resolveUndoBlocks('dogecoin-mainnet', 0)).to.equal(DEFAULT_UNDO_BLOCKS.DOGE);
  });

  it('falls back to the per-chain default when optsUndoBlocks is non-integer', function () {
    expect(resolveUndoBlocks('bitcoin-mainnet', 4.5)).to.equal(DEFAULT_UNDO_BLOCKS.BTC);
  });

  it('honors a valid positive integer optsUndoBlocks', function () {
    expect(resolveUndoBlocks('bitcoin-mainnet', 30)).to.equal(30);
  });

  it('still returns and warns when optsUndoBlocks exceeds MAX_SAFE_UNDO_BLOCKS', function () {
    const over = MAX_SAFE_UNDO_BLOCKS + 1;
    expect(resolveUndoBlocks('dogecoin-mainnet', over)).to.equal(over);
    expect(consoleErrorStub.calledOnce).to.equal(true);
    expect(consoleErrorStub.firstCall.args[0]).to.match(/exceeds the decoder dispenser-expiry safe depth/);
  });

  it('does not warn when a valid optsUndoBlocks is within the safe ceiling', function () {
    resolveUndoBlocks('bitcoin-mainnet', 30);
    expect(consoleErrorStub.called).to.equal(false);
  });
});

// AML #5803: the network->coin step was a hardcoded bitcoin/litecoin/dogecoin
// prefix list returning null for anything else, even though the constructor
// comment above `this.auxPow = WIRE_FORMAT[coinFromNetwork(network)]` promised
// the answer came from the canonical registry "so onboarding a merge-mined
// chain is a registry edit". It did not: a chain added to src/coins alone
// resolved to null, so auxPow silently read false and the reorg window silently
// fell to the flat 12-block fallback, i.e. merged-mined headers parsed as plain
// Bitcoin headers with a window sized for 10-minute blocks.
describe('undo-blocks resolves the coin through the canonical registry (#5803)', function () {
  const coins = require('../../src/coins');
  const { coinFromNetwork } = require('../../src/undo-blocks');

  // Onboard a coin the way the comment advertises - registry only - and see
  // what the two consensus-relevant decisions do with it.
  function withRegisteredCoin(tick, fullName, wireFormat, fn) {
    coins.FULL_NAME_TO_TICK[fullName] = tick;
    coins.WIRE_FORMAT[tick] = wireFormat;
    try { return fn(); }
    finally {
      delete coins.FULL_NAME_TO_TICK[fullName];
      delete coins.WIRE_FORMAT[tick];
    }
  }

  it('resolves every registered coin from the registry, not a name literal', function () {
    expect(coins.ALLOWED_COINS.length, 'sanity: the registry is not empty').to.be.at.least(1);
    for (const tick of coins.ALLOWED_COINS) {
      const full = coins.COIN_FULL_NAME[tick];
      for (const net of coins.NETWORKS) {
        expect(coinFromNetwork(`${full}-${net}`), `${full}-${net}`).to.equal(tick);
      }
    }
  });

  it('resolves a coin that exists ONLY in the registry', function () {
    withRegisteredCoin('MONA', 'monacoin', 'auxpow', function () {
      expect(coinFromNetwork('monacoin-mainnet')).to.equal('MONA');
      expect(coins.WIRE_FORMAT[coinFromNetwork('monacoin-mainnet')]).to.equal('auxpow');
    });
  });

  it('refuses a registered coin that has no per-chain reorg window, rather than defaulting to 12', function () {
    withRegisteredCoin('MONA', 'monacoin', 'auxpow', function () {
      expect(() => resolveUndoBlocks('monacoin-mainnet')).to.throw(/monacoin-mainnet|MONA/);
      // An explicit override must not mask the gap either: the missing window is
      // a registry-onboarding bug, not something a caller can opt out of.
      expect(() => resolveUndoBlocks('monacoin-mainnet', 30)).to.throw(/monacoin-mainnet|MONA/);
    });
  });

  it('refuses a network name no registered coin claims', function () {
    expect(coinFromNetwork('unknowncoin-mainnet')).to.equal(null);
    expect(() => resolveUndoBlocks('unknowncoin-mainnet')).to.throw(/unknowncoin-mainnet/);
  });

  it('still resolves the three shipped chains to their pinned windows', function () {
    expect(resolveUndoBlocks('bitcoin-mainnet')).to.equal(DEFAULT_UNDO_BLOCKS.BTC);
    expect(resolveUndoBlocks('litecoin-mainnet')).to.equal(DEFAULT_UNDO_BLOCKS.LTC);
    expect(resolveUndoBlocks('dogecoin-regtest')).to.equal(DEFAULT_UNDO_BLOCKS.DOGE);
  });
});
