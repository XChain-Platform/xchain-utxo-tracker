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
// manual resync; a later change sized it per NETWORK as well (testnets initially
// 120), after a coin-keyed table handed bitcoin testnet mainnet's 12. Litecoin
// testnet later moved to 5000 after a public fork outran 120. The window is
// resolved at construction into this.undoBlocks, with an env override
// (XCHAIN_UNDO_BLOCKS_<COIN>). A reversion to a flat constant would silently
// shrink DOGE/LTC headroom, and a reversion to a coin-keyed table would shrink
// BTC testnet's; this pins each (coin, net) value and the override behaviour.
//
// An unrecognised NETWORK is rejected at construction, because bitcoinjs-lib
// silently treats an undefined network as BTC mainnet, so a typo would run under
// the wrong network parameters. Item 5803 REMOVED the 12-block fallback for "a coin
// the window map omits": the coin that reaches that path is a newly onboarded
// one, so a window sized for 10-minute BTC blocks is wrong in exactly the
// unsafe direction. It is a refusal now, pinned in
// test/unit/undo-blocks.test.js.

const { expect } = require('chai');
const XChainUtxoTracker = require('../../../src/XChainUtxoTracker');
const { DEFAULT_UNDO_BLOCKS } = require('../../../src/chain/undo_blocks');

// Construct a tracker WITHOUT starting it (mirrors createTestTracker) so we only
// exercise the constructor's window resolution.
function undoBlocksFor(network) {
  const t = new XChainUtxoTracker(network, '127.0.0.1', '0', 'u', 'p', 'undo-test-db', false);
  return t.undoBlocks;
}

describe('Regression (0e8c043): per-chain reorg recovery window', function () {

  it('Bitcoin keeps the 12-block window on mainnet and regtest', function () {
    expect(undoBlocksFor('bitcoin-mainnet')).to.equal(12);
    expect(undoBlocksFor('bitcoin-regtest')).to.equal(12);
  });

  // The table was keyed by coin, so bitcoin testnet inherited mainnet's
  // 12 and a validator's tracker drained it to zero at 150774 (2026-09-15), the
  // same failure litecoin testnet had at 48 on 2026-09-01. Testnet is sized
  // separately now, with each coin pinned to its own safe value.
  it('pins each testnet to its network-specific window', function () {
    expect(undoBlocksFor('bitcoin-testnet')).to.equal(120);
    expect(undoBlocksFor('bitcoin-testnet')).to.not.equal(12);
    expect(undoBlocksFor('litecoin-testnet')).to.equal(5000);
    expect(undoBlocksFor('dogecoin-testnet')).to.equal(120);
  });

  // Litecoin mainnet remains block-time-scaled at 120. The testnet fork that
  // outran 120 now has its own 5000-block window, with MAX_SAFE_UNDO_BLOCKS and
  // the decoder's DISPENSER_EXPIRE_SAFE_DEPTH moved in lockstep.
  it('Litecoin mainnet stays at 120 blocks', function () {
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
    expect(require('../../../src/chain/undo_blocks')).to.not.have.property('FALLBACK_UNDO_BLOCKS');
    expect(DEFAULT_UNDO_BLOCKS).to.not.have.property('XXX');
  });
});

describe('Regression (0e8c043): per-chain reorg recovery window', function () {
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

    // A resolver that honors a non-positive override
    // (`parseInt(...) || default` treats a negative as truthy) yields a
    // negative window that mass-purges undo records; a bare `> 0` check
    // disagrees with that shape across paths. Both paths share the single
    // resolver, so a non-positive override falls back to the per-chain default
    // on BOTH, in agreement.
    const { resolveUndoBlocks: seederResolveNP } = require('../../../src/bulk-sync/merger/derive_keys.js');
    for (const bad of ['-5', '0']) {
      it('a non-positive override (' + bad + ') falls back to the default on live AND seeder', function () {
        process.env.XCHAIN_UNDO_BLOCKS_DOGE = bad;
        expect(undoBlocksFor('dogecoin-mainnet')).to.equal(120);
        expect(seederResolveNP('dogecoin-mainnet')).to.equal(120);
      });
    }
  });
});

// The live worker and the bulk seeder must agree on the per-chain window, or the
// bulk-seeded N-prefix can undershoot the live reorg depth guard for one chain (the gap
// commit 51aab3b closed). Both now import the single table in src/chain/undo_blocks.js, so this asserts
// the bulk seeder resolves the same per-chain values as the live tracker (no hand-copied
// second table to drift).
describe('Regression (0e8c043): per-chain reorg recovery window', function () {
  describe('bulk seeder shares the live per-chain window (single-source)', function () {
    const { resolveUndoBlocks: seederResolve } = require('../../../src/bulk-sync/merger/derive_keys.js');
    for (const [network, expected] of [['bitcoin-mainnet', 12], ['litecoin-mainnet', 120], ['dogecoin-mainnet', 120],
                                       ['bitcoin-testnet', 120], ['litecoin-testnet', 5000], ['dogecoin-testnet', 120],
                                       ['bitcoin-regtest', 12]]) {
      it(network + ' matches between live worker and bulk seeder (' + expected + ')', function () {
        expect(undoBlocksFor(network)).to.equal(expected);
        expect(seederResolve(network)).to.equal(expected);
      });
    }
  });
});

// The drive: a bitcoin TESTNET tracker survives a fork deeper than
// mainnet's 12-block window.
//
// Measured 2026-09-15 on an external validator's bitcoin testnet tracker: it
// halted on every restart at 150774 with
//
//     Can't delete a block from 'last blocks': list is empty
//
// because the persisted undo window had been drained to zero by earlier
// rollbacks. The window behind that was DEFAULT_UNDO_BLOCKS keyed by COIN, so
// bitcoin testnet carried mainnet's 12 while its minimum-difficulty rule forks
// far deeper than 10-minute block time predicts (the same event took litecoin
// testnet past 48 on 2026-09-01).
//
// These drive the real store and the real verifyReorg on a tracker CONSTRUCTED
// for bitcoin-testnet, so the window under test is the one the constructor
// resolves, not one set by hand. The control drives the identical fork under
// the pre-fix number and shows it halting with the rebuild remedy. They live in
// this file rather than a subdirectory because the unquoted glob in the
// test:regression script lets the shell expand ** as *, which would narrow the
// run to the subdirectory alone.

const LevelUpStore = require('../../../src/store/level_up_db');
const { captureLog } = require('../../helpers/capture_log');
const {
    closeTracker,
    processBlocksAndCommit,
    buildCoinbaseChain
} = require('../../integration/support/helpers');

// The reporter's fork was deeper than 12; 13 is the shallowest depth that
// separates the two windows.
const FORK_DEPTH = 13;
// Enough committed blocks for a 120-block window to fill and the fork to land
// well inside it.
const CHAIN_LENGTH = 134;

// createTestTracker() in the integration helpers is pinned to bitcoin-regtest,
// which resolves the same 12 as mainnet; this suite needs the constructor to run
// for bitcoin-testnet. Same in-memory stores, same static-cache reset.
async function createTestnetTracker() {
    const tracker = new XChainUtxoTracker(
        'bitcoin-testnet', '127.0.0.1', '18332', 'user', 'pass', 'test-db', false
    );
    LevelUpStore.knownScripts = new Set();
    const db = new LevelUpStore('tracker-testnet-' + Date.now() + '-' + Math.random(), true);
    const mempoolDb = new LevelUpStore('mempool-testnet-' + Date.now() + '-' + Math.random(), true);
    await db.createDatabase();
    await mempoolDb.createDatabase();
    tracker.db = db;
    tracker.mempoolDb = mempoolDb;
    tracker.blockchainInfoLastBlock = 1000;
    tracker.coinbaseMaturity = 0;
    tracker.sleep = async () => {};
    return tracker;
}

// A node whose chain agrees with ours at and below `forkHeight` and disagrees
// above it, which is what drives verifyReorg's rollback walk.
function nodeForkedAt(blocks, forkHeight) {
    return {
        getBlockHash: async (h) => (h <= forkHeight ? blocks[h].hash : 'ff'.repeat(31) + h.toString(16).padStart(2, '0'))
    };
}

async function commitChain(tracker) {
    const blocks = buildCoinbaseChain(CHAIN_LENGTH, 0, 0);
    await processBlocksAndCommit(tracker, blocks);
    return blocks;
}

async function driveFork(tracker, blocks) {
    const tip = CHAIN_LENGTH - 1;
    const forkHeight = tip - FORK_DEPTH;
    tracker.connector = nodeForkedAt(blocks, forkHeight);
    tracker.lastBlocks = await tracker.loadLastBlocksSortedByHeight();
    let err = null;
    try {
        await tracker.verifyReorg();
    } catch (e) {
        err = e;
    }
    return { err, forkHeight };
}

let tracker;
let errors;
let release;

function registerHooks() {
    beforeEach(async function () {
        tracker = await createTestnetTracker();
        errors = [];
        release = captureLog(['error'], (level, msg) => errors.push(msg));
    });
    afterEach(async function () {
        release();
        await closeTracker(tracker);
    });
}

describe('Regression: bitcoin testnet outlives a fork deeper than mainnet\'s window', function () {
    this.timeout(0);
    registerHooks();

    it('the constructor resolves 120 for bitcoin-testnet, not the 12 the coin-keyed table gave it', function () {
        expect(tracker.undoBlocks).to.equal(120);
    });

    it('rolls a 13-block fork back onto the node\'s chain and keeps window to spare', async function () {
        const blocks = await commitChain(tracker);
        // The persisted window is full at the constructor's depth before the fork.
        expect(await tracker.loadLastBlocksSortedByHeight()).to.have.length(120);

        const { err, forkHeight } = await driveFork(tracker, blocks);

        expect(err, 'a 13-deep fork fits a 120-block window').to.equal(null);
        expect(await tracker.db.getLastBlockHeight()).to.equal(forkHeight);
        expect(await tracker.db.getLastBlockHash()).to.equal(blocks[forkHeight].hash);
        // Thirteen N records spent out of 120; the tracker is nowhere near the
        // empty-list wall the reporter hit.
        expect(tracker.lastBlocks).to.have.length(120 - FORK_DEPTH);
        expect(tracker.lastBlocks[tracker.lastBlocks.length - 1]).to.equal(blocks[forkHeight].hash);
        expect(errors.join('\n')).to.not.match(/exceeds the recovery window/);
        expect(tracker.halted, 'no halt was declared').to.not.equal(true);
    });
});

// The control: the same store, the same fork, under the number bitcoin testnet
// read before the fix. A reverted table makes the test above fail exactly the
// way this one passes.
describe('Regression control: mainnet\'s 12-block window halts on the same fork', function () {
    this.timeout(0);
    registerHooks();

    it('control: under mainnet\'s 12 the identical fork halts with the rebuild remedy', async function () {
        // The pre-fix reading, applied before the commit so the persisted window
        // is the 12 records a pre-fix tracker would have held.
        tracker.undoBlocks = 12;
        const blocks = await commitChain(tracker);
        expect(await tracker.loadLastBlocksSortedByHeight()).to.have.length(12);

        const { err } = await driveFork(tracker, blocks);

        expect(err, 'verifyReorg must refuse once the 12-block budget is spent').to.be.an('error');
        expect(XChainUtxoTracker.isUnrecoverableReorg(err)).to.equal(true);
        expect(err.message).to.match(/reorg depth exceeds the recovery window \(UNDO_BLOCKS=12\)/);
        expect(err.message).to.match(/xchain-node reset xchain-utxo-tracker <coin> <network>/);
        // Twelve of the thirteen were walked back before the guard fired, which is
        // the drained window the reporter's restarts kept finding.
        expect(tracker.lastBlocks).to.have.length(0);
        expect(await tracker.db.getLastBlockHeight()).to.equal(CHAIN_LENGTH - 1 - 12);
    });
});
