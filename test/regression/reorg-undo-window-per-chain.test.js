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

// Regression: per-chain reorg recovery window (UNDO_BLOCKS).
//
// Commit 0e8c043 made the reorg recovery window per-chain instead of a flat 10.
// On 1-minute DOGE blocks a flat window was only ~10 minutes of headroom; the
// fix sizes the window by coin (BTC 12, LTC 120, DOGE 120) so an ordinary reorg
// inside the cross-chain confirmation gate auto-recovers instead of forcing a
// manual resync. The window is resolved at construction into this.undoBlocks,
// with an env override (XCHAIN_UNDO_BLOCKS_<COIN>). A reversion to a flat
// constant would silently shrink DOGE/LTC headroom; this pins each coin's value
// and the override behaviour.
//
// An unrecognised NETWORK is rejected at construction, because bitcoinjs-lib
// silently treats an undefined network as BTC mainnet, so a typo would run under
// the wrong network parameters. Item 5803 REMOVED the 12-block fallback for "a coin
// the window map omits": the coin that reaches that path is a newly onboarded
// one, so a window sized for 10-minute BTC blocks is wrong in exactly the
// unsafe direction. It is a refusal now, pinned in
// test/unit/undo-blocks.test.js.

const { expect } = require('chai');
const XChainUtxoTracker = require('../../src/XChainUtxoTracker');
const { DEFAULT_UNDO_BLOCKS } = require('../../src/undo-blocks');

// Construct a tracker WITHOUT starting it (mirrors createTestTracker) so we only
// exercise the constructor's window resolution.
function undoBlocksFor(network) {
  const t = new XChainUtxoTracker(network, '127.0.0.1', '0', 'u', 'p', 'undo-test-db', false);
  return t.undoBlocks;
}

describe('Regression (0e8c043): per-chain reorg recovery window', function () {

  it('Bitcoin keeps the 12-block window', function () {
    expect(undoBlocksFor('bitcoin-mainnet')).to.equal(12);
    expect(undoBlocksFor('bitcoin-regtest')).to.equal(12);
  });

  // Raised from 48 on 2026-09-01: a litecoin testnet fork walked past the
  // ~2-hour window a 48-block sizing gives, exhausted the rollback budget and
  // forced a full tracker rebuild. 120 is the deepest value available without
  // moving MAX_SAFE_UNDO_BLOCKS and the decoder's DISPENSER_EXPIRE_SAFE_DEPTH
  // in lockstep.
  it('Litecoin widens to 120 blocks', function () {
    expect(undoBlocksFor('litecoin-mainnet')).to.equal(120);
    // Assert we are NOT back to the window the testnet fork outran.
    expect(undoBlocksFor('litecoin-mainnet')).to.not.equal(48);
  });

  it('Dogecoin widens to 120 blocks (the flat-10 regression target)', function () {
    expect(undoBlocksFor('dogecoin-mainnet')).to.equal(120);
    // Assert we are NOT back to the pre-fix flat value.
    expect(undoBlocksFor('dogecoin-mainnet')).to.not.equal(10);
  });

  it('rejects an unrecognised network at construction', function () {
    expect(() => undoBlocksFor('unknowncoin-mainnet')).to.throw(/unknown network/i);
  });

  it('exposes no generic fallback window for a coin the map omits (item 5803)', function () {
    expect(require('../../src/undo-blocks')).to.not.have.property('FALLBACK_UNDO_BLOCKS');
    expect(DEFAULT_UNDO_BLOCKS).to.not.have.property('XXX');
  });

  describe('env override XCHAIN_UNDO_BLOCKS_<COIN>', function () {
    const saved = {};
    beforeEach(function () { saved.DOGE = process.env.XCHAIN_UNDO_BLOCKS_DOGE; });
    afterEach(function () {
      if (saved.DOGE === undefined) delete process.env.XCHAIN_UNDO_BLOCKS_DOGE;
      else process.env.XCHAIN_UNDO_BLOCKS_DOGE = saved.DOGE;
    });

    it('an explicit env value overrides the per-chain default', function () {
      process.env.XCHAIN_UNDO_BLOCKS_DOGE = '200';
      expect(undoBlocksFor('dogecoin-mainnet')).to.equal(200);
    });

    it('a non-numeric env value falls back to the per-chain default (not NaN)', function () {
      process.env.XCHAIN_UNDO_BLOCKS_DOGE = 'not-a-number';
      expect(undoBlocksFor('dogecoin-mainnet')).to.equal(120);
    });

    // The live resolver used to honor a non-positive override
    // (`parseInt(...) || default` treats a negative as truthy), yielding a
    // negative window that mass-purged undo records, while the seeder rejected
    // it via `> 0`. Both share the single resolver now, so a non-positive
    // override falls back to the per-chain default on BOTH paths, in agreement.
    const { resolveUndoBlocks: seederResolveNP } = require('../../src/bulk-sync/merger/derive-keys.js');
    for (const bad of ['-5', '0']) {
      it('a non-positive override (' + bad + ') falls back to the default on live AND seeder', function () {
        process.env.XCHAIN_UNDO_BLOCKS_DOGE = bad;
        expect(undoBlocksFor('dogecoin-mainnet')).to.equal(120);
        expect(seederResolveNP('dogecoin-mainnet')).to.equal(120);
      });
    }
  });

  // The live worker and the bulk seeder must agree on the per-chain window, or the
  // bulk-seeded N-prefix can undershoot the live reorg depth guard for one chain (the gap
  // commit 51aab3b closed). Both now import the single table in src/undo-blocks.js, so this asserts
  // the bulk seeder resolves the same per-chain values as the live tracker (no hand-copied
  // second table to drift).
  describe('bulk seeder shares the live per-chain window (single-source)', function () {
    const { resolveUndoBlocks: seederResolve } = require('../../src/bulk-sync/merger/derive-keys.js');
    for (const [network, expected] of [['bitcoin-mainnet', 12], ['litecoin-mainnet', 120], ['dogecoin-mainnet', 120]]) {
      it(network + ' matches between live worker and bulk seeder (' + expected + ')', function () {
        expect(undoBlocksFor(network)).to.equal(expected);
        expect(seederResolve(network)).to.equal(expected);
      });
    }
  });
});
