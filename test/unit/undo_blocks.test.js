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
const { resolveUndoBlocks, DEFAULT_UNDO_BLOCKS, MAX_SAFE_UNDO_BLOCKS } = require('../../src/chain/undo_blocks');

describe('resolveUndoBlocks opts validation', function () {
  let consoleErrorStub;

  beforeEach(function () {
    consoleErrorStub = sinon.stub(console, 'error');
  });

  afterEach(function () {
    consoleErrorStub.restore();
  });

  it('falls back to the per-chain default when optsUndoBlocks is negative', function () {
    expect(resolveUndoBlocks('dogecoin-mainnet', -5)).to.equal(DEFAULT_UNDO_BLOCKS.DOGE_MAINNET);
  });

  it('falls back to the per-chain default when optsUndoBlocks is zero', function () {
    expect(resolveUndoBlocks('dogecoin-mainnet', 0)).to.equal(DEFAULT_UNDO_BLOCKS.DOGE_MAINNET);
  });

  it('falls back to the per-chain default when optsUndoBlocks is non-integer', function () {
    expect(resolveUndoBlocks('bitcoin-mainnet', 4.5)).to.equal(DEFAULT_UNDO_BLOCKS.BTC_MAINNET);
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
  const { coinFromNetwork } = require('../../src/chain/undo_blocks');

  const coins = require('../../src/coins');
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
    expect(resolveUndoBlocks('bitcoin-mainnet')).to.equal(DEFAULT_UNDO_BLOCKS.BTC_MAINNET);
    expect(resolveUndoBlocks('litecoin-mainnet')).to.equal(DEFAULT_UNDO_BLOCKS.LTC_MAINNET);
    expect(resolveUndoBlocks('dogecoin-regtest')).to.equal(DEFAULT_UNDO_BLOCKS.DOGE_REGTEST);
  });
});

// The table was keyed by COIN, so a testnet read its coin's mainnet
// window. Its own comment recorded the 2026-09-01 litecoin-testnet fork that
// raised LTC to 120 and said a testnet's minimum-difficulty rule forks deeper
// than block time predicts, yet bitcoin testnet was left on mainnet's 12 and a
// validator's tracker drained that window to zero at 150774 on 2026-09-15. The
// window is per (coin, net) now; these pin the numbers each net resolves to.
describe('undo-blocks resolves the window per network, not per coin', function () {
  const { netFromNetwork, undoBlocksKey } = require('../../src/chain/undo_blocks');
  const coins = require('../../src/coins');
  let errorStub;
  beforeEach(function () { errorStub = sinon.stub(console, 'error'); });
  afterEach(function () { errorStub.restore(); });

  it('bitcoin testnet resolves 120 while bitcoin mainnet keeps 12', function () {
    expect(resolveUndoBlocks('bitcoin-testnet')).to.equal(120);
    expect(resolveUndoBlocks('bitcoin-mainnet')).to.equal(12);
    // The pre-fix reading: the number that drained to zero on the reporter's box.
    expect(resolveUndoBlocks('bitcoin-testnet')).to.not.equal(12);
  });

  it('litecoin testnet uses the 5000-block public-testnet window', function () {
    expect(resolveUndoBlocks('litecoin-testnet')).to.equal(5000);
    expect(resolveUndoBlocks('litecoin-mainnet')).to.equal(120);
    expect(resolveUndoBlocks('litecoin-regtest')).to.equal(120);
  });

  it('keeps the other tracked testnet defaults unchanged', function () {
    expect(resolveUndoBlocks('bitcoin-testnet')).to.equal(120);
    expect(resolveUndoBlocks('dogecoin-testnet')).to.equal(120);
  });

  it('LTC and DOGE keep 120 on mainnet; regtest keeps the mainnet numbers', function () {
    expect(resolveUndoBlocks('litecoin-mainnet')).to.equal(120);
    expect(resolveUndoBlocks('dogecoin-mainnet')).to.equal(120);
    for (const tick of coins.ALLOWED_COINS) {
      const full = coins.COIN_FULL_NAME[tick];
      expect(resolveUndoBlocks(full + '-regtest'), tick + ' regtest').to.equal(resolveUndoBlocks(full + '-mainnet'));
    }
  });

  it('carries a window for every registered (coin, net) pair and nothing else', function () {
    const expected = [];
    for (const tick of coins.ALLOWED_COINS) {
      for (const net of coins.NETWORKS) expected.push(undoBlocksKey(tick, net));
    }
    expect(Object.keys(DEFAULT_UNDO_BLOCKS).sort()).to.deep.equal(expected.sort());
    // Flat numeric values: the decoder's dispenser_safe_depth conformance takes
    // Math.max over Object.values of this export, and a nested shape reads NaN.
    for (const v of Object.values(DEFAULT_UNDO_BLOCKS)) expect(Number.isInteger(v)).to.equal(true);
  });
});

describe('undo-blocks enforces network-specific safety ceilings', function () {
  const { netFromNetwork, undoBlocksKey } = require('../../src/chain/undo_blocks');
  const coins = require('../../src/coins');

  it('no default exceeds its network-specific decoder lockstep ceiling', function () {
    const { safeUndoBlocksCeiling } = require('../../src/chain/undo_blocks');
    for (const tick of coins.ALLOWED_COINS) {
      const full = coins.COIN_FULL_NAME[tick];
      for (const net of coins.NETWORKS) {
        const key = undoBlocksKey(tick, net);
        expect(DEFAULT_UNDO_BLOCKS[key], key).to.be.at.most(safeUndoBlocksCeiling(full + '-' + net));
      }
    }
    expect(safeUndoBlocksCeiling('litecoin-mainnet')).to.equal(MAX_SAFE_UNDO_BLOCKS);
    expect(safeUndoBlocksCeiling('litecoin-testnet')).to.equal(5006);
  });

  it('refuses a network with no net suffix rather than guessing a net', function () {
    expect(netFromNetwork('bitcoin')).to.equal('');
    expect(() => resolveUndoBlocks('bitcoin')).to.throw(/no reorg-recovery window for net ""/);
  });
});

// Same finding, the override side: the coin-only env key still governs both
// nets of its coin, and the decoder lockstep warning still fires on a testnet
// window pushed past the ceiling.
describe('undo-blocks per-network window: the coin override and the lockstep warning', function () {
  const KEY = 'XCHAIN_UNDO_BLOCKS_BTC';
  let errorStub;
  let had;
  let prev;
  beforeEach(function () {
    errorStub = sinon.stub(console, 'error');
    had = Object.prototype.hasOwnProperty.call(process.env, KEY);
    prev = process.env[KEY];
  });
  afterEach(function () {
    errorStub.restore();
    if (had) process.env[KEY] = prev; else delete process.env[KEY];
  });

  it('XCHAIN_UNDO_BLOCKS_<COIN> still wins on testnet', function () {
    process.env[KEY] = '60';
    expect(resolveUndoBlocks('bitcoin-testnet')).to.equal(60);
    expect(resolveUndoBlocks('bitcoin-mainnet')).to.equal(60);
  });

  it('the lockstep guard still fires on a testnet window pushed past the ceiling', function () {
    process.env[KEY] = String(MAX_SAFE_UNDO_BLOCKS + 1);
    expect(resolveUndoBlocks('bitcoin-testnet')).to.equal(MAX_SAFE_UNDO_BLOCKS + 1);
    expect(errorStub.args.join('\n')).to.match(/exceeds the decoder dispenser-expiry safe depth/);
    expect(errorStub.args.join('\n')).to.match(/bitcoin-testnet/);
  });
});

// The env override ran through parseInt BEFORE the Number.isInteger/> 0 guard,
// so the guard only ever inspected an already-truncated number and could not
// refuse anything an operator actually typed: '1.5' resolved to 1 and
// '12garbage' to 12, silently shortening the reorg-recovery window on every
// consumer of this single-sourced resolver at once (item 7714).
const KEY = 'XCHAIN_UNDO_BLOCKS_DOGE';
const saved = {};
let consoleErrorStub;

describe('resolveUndoBlocks env-override validation (item 7714)', function () {
  beforeEach(function () {
    saved.had = Object.prototype.hasOwnProperty.call(process.env, KEY);
    saved.value = process.env[KEY];
    consoleErrorStub = sinon.stub(console, 'error');
  });

  afterEach(function () {
    consoleErrorStub.restore();
    if (saved.had) process.env[KEY] = saved.value;
    else delete process.env[KEY];
  });

  // The control: what the pre-fix arithmetic did with these same strings. A
  // reverted resolver returns THESE numbers, which is what reddens the cases
  // below rather than leaving them vacuously green.
  it('the parseInt read this replaced truncates the malformed values', function () {
    expect(parseInt('1.5', 10)).to.equal(1);
    expect(parseInt('12garbage', 10)).to.equal(12);
    expect(Number.isInteger(parseInt('1.5', 10))).to.equal(true);
  });

  for (const bad of ['1.5', '12garbage', '0.9', ' 7.5 ', 'ten']) {
    it('refuses ' + JSON.stringify(bad) + ' and keeps the per-chain default', function () {
      process.env[KEY] = bad;
      expect(resolveUndoBlocks('dogecoin-mainnet')).to.equal(DEFAULT_UNDO_BLOCKS.DOGE_MAINNET);
      expect(consoleErrorStub.args.join('\n')).to.match(/is not an integer/);
    });
  }
});

describe('resolveUndoBlocks env-override validation (item 7714)', function () {
  beforeEach(function () {
    saved.had = Object.prototype.hasOwnProperty.call(process.env, KEY);
    saved.value = process.env[KEY];
    consoleErrorStub = sinon.stub(console, 'error');
  });

  afterEach(function () {
    consoleErrorStub.restore();
    if (saved.had) process.env[KEY] = saved.value;
    else delete process.env[KEY];
  });

  it('accepts a well-formed override, trimmed', function () {
    process.env[KEY] = '60';
    expect(resolveUndoBlocks('dogecoin-mainnet')).to.equal(60);
    process.env[KEY] = ' 60 ';
    expect(resolveUndoBlocks('dogecoin-mainnet')).to.equal(60);
    expect(consoleErrorStub.called).to.equal(false);
  });

  // Documented decision, not an accident: Number() reads '1e2' as exactly 100.
  // The defect fixed here is silent truncation, not exponent notation.
  it('accepts exponent notation as the integer it spells', function () {
    process.env[KEY] = '1e2';
    expect(resolveUndoBlocks('dogecoin-mainnet')).to.equal(100);
  });

  it('an unset or blank override takes the default without warning', function () {
    delete process.env[KEY];
    expect(resolveUndoBlocks('dogecoin-mainnet')).to.equal(DEFAULT_UNDO_BLOCKS.DOGE_MAINNET);
    process.env[KEY] = '   ';
    expect(resolveUndoBlocks('dogecoin-mainnet')).to.equal(DEFAULT_UNDO_BLOCKS.DOGE_MAINNET);
    expect(consoleErrorStub.called).to.equal(false);
  });

  it('an explicit opts value still wins over a malformed env override', function () {
    process.env[KEY] = '1.5';
    expect(resolveUndoBlocks('dogecoin-mainnet', 30)).to.equal(30);
  });
});
