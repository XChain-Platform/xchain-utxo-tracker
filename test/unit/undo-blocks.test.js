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

// ─── Regression (item 2407): resolveUndoBlocks must validate optsUndoBlocks ───
//
// resolveUndoBlocks previously short-circuited on a truthy optsUndoBlocks
// before running the integer/positive validation or the MAX_SAFE ceiling
// warning that the env path applies. That let resolveUndoBlocks(network, -5)
// return -5 outright (a negative undo-blocks window degenerates the aging
// loop into a mass undo purge), and let a non-integer opts value pass through
// unvalidated. The fix routes the explicit opts value through the same
// integer/positive check as the env override, falling back to the per-chain
// default on an invalid value, and still applies the MAX_SAFE_UNDO_BLOCKS
// ceiling warning uniformly regardless of which path produced the value.

const { expect } = require('chai');
const sinon = require('sinon');
const { resolveUndoBlocks, DEFAULT_UNDO_BLOCKS, MAX_SAFE_UNDO_BLOCKS } = require('../../src/undo-blocks');

describe('resolveUndoBlocks opts validation (item 2407)', function () {
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
