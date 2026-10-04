'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect } = require('chai');
const {
  satoshiToDecimalString,
  nodeTipIsParseable,
  nodeStillCatchingUp,
  catchUpWaitState
} = require('../../../src/XChainUtxoTracker/catch_up_helpers.js');

describe('catch-up helpers: satoshiToDecimalString', function () {
  it('formats zero, one satoshi, and twenty-one million coins exactly', function () {
    expect(satoshiToDecimalString(0n)).to.equal('0.00000000');
    expect(satoshiToDecimalString(1n)).to.equal('0.00000001');
    expect(satoshiToDecimalString(2100000000000000n)).to.equal('21000000.00000000');
  });
});

describe('catch-up helpers: nodeTipIsParseable', function () {
  it('rejects a missing node reply', function () {
    expect(nodeTipIsParseable(null, 'mainnet')).to.equal(false);
  });

  it('accepts every regtest reply regardless of progress', function () {
    expect(nodeTipIsParseable({ verificationprogress: 0 }, 'regtest')).to.equal(true);
  });

  it('applies the progress threshold outside regtest', function () {
    expect(nodeTipIsParseable({ verificationprogress: 0.98999 }, 'mainnet')).to.equal(false);
    expect(nodeTipIsParseable({ verificationprogress: 0.99 }, 'mainnet')).to.equal(true);
    expect(nodeTipIsParseable({}, 'testnet')).to.equal(true);
  });
});

describe('catch-up helpers: nodeStillCatchingUp', function () {
  it('accepts only a present reply with literal initialblockdownload true', function () {
    expect(nodeStillCatchingUp({ initialblockdownload: true })).to.equal(true);
    expect(nodeStillCatchingUp({ initialblockdownload: false })).to.equal(false);
    expect(nodeStillCatchingUp({ initialblockdownload: 'true' })).to.equal(false);
    expect(nodeStillCatchingUp(null)).to.equal(false);
  });
});

describe('catch-up helpers: catchUpWaitState', function () {
  it('creates a timestamp for a new wait', function () {
    const state = catchUpWaitState(null, 120, 125);

    expect(state.node_height).to.equal(120);
    expect(state.stored_height).to.equal(125);
    expect(new Date(state.since).toISOString()).to.equal(state.since);
  });

  it('preserves a truthy timestamp while refreshing both heights', function () {
    const since = '2026-10-04T12:00:00.000Z';
    const state = catchUpWaitState({ since }, 123, 125);

    expect(state).to.deep.equal({
      node_height: 123,
      stored_height: 125,
      since
    });
  });

  it('replaces an empty prior timestamp', function () {
    const state = catchUpWaitState({ since: '' }, 124, 125);

    expect(state.since).to.not.equal('');
    expect(new Date(state.since).toISOString()).to.equal(state.since);
  });
});
