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
const XChainUtxoTracker = require('../../src/XChainUtxoTracker');
const { refreshNodeTip } = require('../../src/XChainUtxoTracker/sync_loop_node_tip.js');

// A tip-below walk can delete blocks and then refuse mid-walk (the node tip
// fell again while a hash fetch was failing). The refusal returns without a
// fatal error, so the in-memory cursor must be re-read from the store: if it
// keeps the pre-walk tip, restoring the node tip makes the loop compare equal
// hashes at the old height and idle "at tip" over the deleted range.
describe('rollBackToNodeTip refusal after deletes', function () {
  this.timeout(0);

  const H = 100;
  const DELETED_TO = H - 12;

  function build() {
    const tracker = new XChainUtxoTracker(
      'bitcoin-regtest', '127.0.0.1', '18443', 'user', 'pass', 'test-db', false
    );
    tracker.sleep = async () => {};
    let top = H;
    tracker.connector = {
      getBlockchainInfo: async () => ({ blocks: H - 40 })
    };
    tracker.db = {
      getLastBlockHeight: async () => top,
      getLastBlockHash: async () => 'db' + top,
      getLastBlock: async () => ({ hash: 'db' + top, height: top })
    };
    tracker.loadLastBlocksSortedByHeight = async () => [];
    tracker.discardInflightBatchForReorg = async () => false;
    // The walk deletes down to DELETED_TO, then refuses with the tagged error.
    tracker.verifyReorg = async () => {
      top = DELETED_TO;
      const err = new Error('node tip below committed tip with 12 block(s) already rolled back');
      err.tipBelowCommittedTip = true;
      throw err;
    };
    const sync = {
      lastProcessedBlockIndex: H,
      lastProcessedBlockHash: 'db' + H,
      tipBelowCommittedTipRefused: false,
      blocksQuantity: 0
    };
    return { tracker, sync };
  }

  it('re-reads the cursor from the store after a refusal that followed deletes', async function () {
    const { tracker, sync } = build();
    await refreshNodeTip.call(tracker, sync);

    expect(sync.tipBelowCommittedTipRefused).to.equal(true);
    expect(sync.lastProcessedBlockIndex).to.equal(await tracker.db.getLastBlockHeight());
    expect(sync.lastProcessedBlockIndex).to.equal(DELETED_TO);
    expect(sync.lastProcessedBlockHash).to.equal('db' + DELETED_TO);
    expect(sync.lastBlockchainInfo).to.equal(null);
  });

  it('does not idle at tip once the node tip is restored to the old height', async function () {
    const { tracker, sync } = build();
    await refreshNodeTip.call(tracker, sync);
    // Node tip restored to H: the cursor must lag it, so the loop indexes
    // forward instead of taking the equal-height idle branch.
    expect(sync.lastProcessedBlockIndex).to.be.lessThan(H);
  });
});
