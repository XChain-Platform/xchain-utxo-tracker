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
const sinon = require('sinon');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { ClassicLevel } = require('classic-level');
const { MemoryLevel } = require('memory-level');
const LevelUpStore = require('../../src/LevelUpDb');
const XChainUtxoTracker = require('../../src/XChainUtxoTracker');
const {
  SATOSHI, TEST_KEYS,
  makeOutput, makeSpendInput, makeTx, makeCoinbaseTx,
  makeBlock, buildCoinbaseChain,
  stubBlockchain, addMempoolTx,
  sleep, waitForHeight, waitForSynced,
  createE2ETracker
} = require('./helpers');

describe('E2E: Persistence — Disk-Backed LevelDB', function () {
  let tmpDir;
  let origCreateDatabase;

  before(function () {
    // Save original createDatabase
    origCreateDatabase = LevelUpStore.prototype.createDatabase;
  });

  beforeEach(function () {
    // Create a unique temp directory for each test
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'utxo-e2e-'));
  });

  afterEach(function () {
    sinon.restore();
    // Restore original createDatabase
    LevelUpStore.prototype.createDatabase = origCreateDatabase;
    // Clean up temp directory
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) { /* ignore cleanup errors */ }
  });

  /**
   * Patch createDatabase to use disk-backed LevelDB in our temp directory.
   * The main DB goes to disk; the mempool DB stays in-memory.
   */
  function patchLevelUpStoreDisk() {
    LevelUpStore.prototype.createDatabase = async function () {
      try {
        if (this.inMemory) {
          this.db = new MemoryLevel({ keyEncoding: 'buffer', valueEncoding: 'buffer' });
        } else {
          const dbPath = path.join(tmpDir, this.dbName);
          this.db = new ClassicLevel(dbPath, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
        }
        await this.db.open();
        return this.db;
      } catch (err) {
        throw new Error("Couldn't open/create LevelDB database");
      }
    };
  }

  // ─── E2E-G2: Tracker Restart with Persisted State ──────────────────────

  describe('G2: restart with persisted state', function () {
    it('survives a full stop/restart cycle with data intact', async function () {
      patchLevelUpStoreDisk();

      // First run: index 5 blocks
      const blocks = buildCoinbaseChain(5, 0, 0, 10 * SATOSHI);
      const tracker1 = createE2ETracker();
      const state1 = stubBlockchain(tracker1, blocks);

      tracker1.start();
      await waitForSynced(tracker1);

      const heightBefore = await tracker1.db.getLastBlockHeight();
      const hashBefore = await tracker1.db.getLastBlockHash();
      expect(heightBefore).to.equal(4);

      // Verify data before shutdown
      const infoBefore = await tracker1.getBalanceInfo(TEST_KEYS[0].address);
      expect(infoBefore.balances.confirmed).to.equal('50.00000000');

      // Stop the tracker (closes DB)
      await tracker1.stopParsing();
      sinon.restore();

      // Second run: create new tracker with SAME dbName, re-open disk DB
      const tracker2 = new XChainUtxoTracker(
        'bitcoin-regtest', '127.0.0.1', '18443', 'user', 'pass',
        tracker1.dbName, false
      );
      const state2 = stubBlockchain(tracker2, blocks);

      tracker2.start();
      await waitForSynced(tracker2);

      // Verify data survived the restart
      const heightAfter = await tracker2.db.getLastBlockHeight();
      expect(heightAfter).to.equal(4);
      expect(await tracker2.db.getLastBlockHash()).to.equal(hashBefore);

      const infoAfter = await tracker2.getBalanceInfo(TEST_KEYS[0].address);
      expect(infoAfter.balances.confirmed).to.equal('50.00000000');
      expect(infoAfter.utxos.confirmed).to.equal(5);

      await tracker2.stopParsing();
    });

    it('resumes indexing from where it left off', async function () {
      patchLevelUpStoreDisk();

      // First run: index 3 blocks
      const initialBlocks = buildCoinbaseChain(3, 0, 0, 10 * SATOSHI);
      const tracker1 = createE2ETracker();
      const state1 = stubBlockchain(tracker1, initialBlocks);

      tracker1.start();
      await waitForSynced(tracker1);
      expect(await tracker1.db.getLastBlockHeight()).to.equal(2);

      await tracker1.stopParsing();
      sinon.restore();

      // Build extended chain (5 blocks total)
      const extendedBlocks = buildCoinbaseChain(5, 0, 0, 10 * SATOSHI);
      // Ensure first 3 blocks have same hashes
      for (let i = 0; i < 3; i++) {
        extendedBlocks[i] = initialBlocks[i];
      }
      // Fix chain linkage for blocks 3-4
      extendedBlocks[3] = makeBlock(3, initialBlocks[2].hash, extendedBlocks[3].transactions);
      extendedBlocks[4] = makeBlock(4, extendedBlocks[3].hash, extendedBlocks[4].transactions);

      // Second run
      const tracker2 = new XChainUtxoTracker(
        'bitcoin-regtest', '127.0.0.1', '18443', 'user', 'pass',
        tracker1.dbName, false
      );
      const state2 = stubBlockchain(tracker2, extendedBlocks);

      tracker2.start();
      await waitForHeight(tracker2, 4);

      expect(await tracker2.db.getLastBlockHeight()).to.equal(4);
      const info = await tracker2.getBalanceInfo(TEST_KEYS[0].address);
      expect(info.balances.confirmed).to.equal('50.00000000');
      expect(info.utxos.confirmed).to.equal(5);

      await tracker2.stopParsing();
    });
  });

  // ─── E2E-G4: Dust Output Handling ──────────────────────────────────────

  describe('G4: dust output (546 satoshis)', function () {
    it('indexes dust values without rounding errors', async function () {
      patchLevelUpStoreDisk();

      const cb = makeCoinbaseTx(0, 546);
      const block0 = makeBlock(0, '0'.repeat(64), [cb]);
      const tracker1 = createE2ETracker();
      const state = stubBlockchain(tracker1, [block0]);

      tracker1.start();
      await waitForSynced(tracker1);

      const info = await tracker1.getBalanceInfo(TEST_KEYS[0].address);
      expect(info.balances.confirmed).to.equal('0.00000546');

      const utxos = await tracker1.getUtxosAddress(TEST_KEYS[0].address);
      expect(utxos).to.have.length(1);
      expect(utxos[0].value).to.equal('546');

      // Verify data survives restart
      await tracker1.stopParsing();
      sinon.restore();

      const tracker2 = new XChainUtxoTracker(
        'bitcoin-regtest', '127.0.0.1', '18443', 'user', 'pass',
        tracker1.dbName, false
      );
      const state2 = stubBlockchain(tracker2, [block0]);

      tracker2.start();
      await waitForSynced(tracker2);

      const infoAfter = await tracker2.getBalanceInfo(TEST_KEYS[0].address);
      expect(infoAfter.balances.confirmed).to.equal('0.00000546');

      await tracker2.stopParsing();
    });
  });

  // ─── E2E-G5: Large Value Output ───────────────────────────────────────

  describe('G5: large value output (BigUInt64BE boundary)', function () {
    it('handles maximum practical value without overflow', async function () {
      patchLevelUpStoreDisk();

      // 21 million BTC in satoshis = 2,100,000,000,000,000
      const maxSats = BigInt('2100000000000000');
      const cb = makeTx({
        ins: [{ hash: Buffer.alloc(32, 0), index: 4294967295, script: Buffer.alloc(4) }],
        outs: [{ value: maxSats, script: TEST_KEYS[0].script }]
      });
      const block0 = makeBlock(0, '0'.repeat(64), [cb]);
      const tracker1 = createE2ETracker();
      const state = stubBlockchain(tracker1, [block0]);

      tracker1.start();
      await waitForSynced(tracker1);

      const info = await tracker1.getBalanceInfo(TEST_KEYS[0].address);
      expect(info.balances.confirmed).to.equal('21000000.00000000');

      // Verify survives restart
      await tracker1.stopParsing();
      sinon.restore();

      const tracker2 = new XChainUtxoTracker(
        'bitcoin-regtest', '127.0.0.1', '18443', 'user', 'pass',
        tracker1.dbName, false
      );
      const state2 = stubBlockchain(tracker2, [block0]);

      tracker2.start();
      await waitForSynced(tracker2);

      const infoAfter = await tracker2.getBalanceInfo(TEST_KEYS[0].address);
      expect(infoAfter.balances.confirmed).to.equal('21000000.00000000');

      await tracker2.stopParsing();
    });
  });

  // ─── E2E-G7: Rapid Block Sequence ─────────────────────────────────────

  describe('G7: rapid block production', function () {
    it('indexes all blocks when many arrive quickly', async function () {
      patchLevelUpStoreDisk();

      const blocks = buildCoinbaseChain(20, 0, 0, 1 * SATOSHI);
      const tracker1 = createE2ETracker();
      const state = stubBlockchain(tracker1, blocks);

      tracker1.start();
      await waitForHeight(tracker1, 19);

      expect(await tracker1.db.getLastBlockHeight()).to.equal(19);

      // 20 coinbase outputs of 1 BTC each (1 * SATOSHI = 100000000 sats)
      const info = await tracker1.getBalanceInfo(TEST_KEYS[0].address);
      expect(info.balances.confirmed).to.equal('20.00000000');
      expect(info.utxos.confirmed).to.equal(20);

      await tracker1.stopParsing();
    });
  });

  // ─── E2E-G8: Mempool Pending Reconvergence After Restart ──────────────

  describe('G8: mempool pending balance reconverges after restart', function () {
    it('rebuilds pending balances from the mempool after a stop/restart cycle', async function () {
      patchLevelUpStoreDisk();

      // First run: one coinbase block funding addr0 with 50 BTC (confirmed).
      const cb = makeCoinbaseTx(0, 50 * SATOSHI);
      const block0 = makeBlock(0, '0'.repeat(64), [cb]);
      const tracker1 = createE2ETracker();
      const state1 = stubBlockchain(tracker1, [block0]);

      tracker1.start();
      await waitForSynced(tracker1);

      // Unconfirmed tx: addr0 → addr1 (10 BTC), addr0 keeps the rest as change.
      const mempoolTx = makeTx({
        ins: [makeSpendInput(cb._txid, 0)],
        outs: [
          makeOutput(1, 10 * SATOSHI),
          makeOutput(0, 39 * SATOSHI)
        ]
      });
      addMempoolTx(state1, mempoolTx);
      await tracker1.updateMempool();

      // Pending is reflected before the restart.
      const pendingBefore = await tracker1.getBalanceInfo(TEST_KEYS[1].address);
      expect(pendingBefore.balances.pending).to.equal('10.00000000');
      expect(pendingBefore.utxos.pending).to.equal(1);
      const addr0Before = await tracker1.getBalanceInfo(TEST_KEYS[0].address);
      expect(addr0Before.balances.confirmed).to.equal('50.00000000');
      // addr0's confirmed 50 BTC coinbase is being spent in the mempool and only
      // 39 BTC returns as change, so pending shows a net deduction of 11 BTC.
      expect(addr0Before.balances.pending).to.equal('-11.00000000');

      // Stop the tracker. The mempool DB is in-memory, so it is discarded here;
      // only the disk-backed confirmed state survives.
      await tracker1.stopParsing();
      sinon.restore();

      // Second run: new tracker, SAME dbName, fresh stub whose mempool is empty.
      // This models the reconvergence window — the in-memory mempool DB did not
      // survive the restart, so pending must be rebuilt from the next scan.
      const tracker2 = new XChainUtxoTracker(
        'bitcoin-regtest', '127.0.0.1', '18443', 'user', 'pass',
        tracker1.dbName, false
      );
      const state2 = stubBlockchain(tracker2, [block0]);

      tracker2.start();
      await waitForSynced(tracker2);

      // Confirmed UTXO state survived; pending was wiped and not yet rebuilt.
      const reconvergeWindowAddr1 = await tracker2.getBalanceInfo(TEST_KEYS[1].address);
      expect(reconvergeWindowAddr1.balances.pending).to.equal('0.00000000');
      expect(reconvergeWindowAddr1.utxos.pending).to.equal(0);
      const reconvergeWindowAddr0 = await tracker2.getBalanceInfo(TEST_KEYS[0].address);
      expect(reconvergeWindowAddr0.balances.confirmed).to.equal('50.00000000');
      expect(reconvergeWindowAddr0.balances.pending).to.equal('0.00000000');

      // The node's mempool still holds the unconfirmed tx; the next scan rebuilds it.
      addMempoolTx(state2, mempoolTx);
      await tracker2.updateMempool();

      // Pending reconverges to the live mempool state.
      const reconvergedAddr1 = await tracker2.getBalanceInfo(TEST_KEYS[1].address);
      expect(reconvergedAddr1.balances.pending).to.equal('10.00000000');
      expect(reconvergedAddr1.utxos.pending).to.equal(1);

      const reconvergedAddr0 = await tracker2.getBalanceInfo(TEST_KEYS[0].address);
      expect(reconvergedAddr0.balances.confirmed).to.equal('50.00000000');
      expect(reconvergedAddr0.balances.pending).to.equal('-11.00000000');

      await tracker2.stopParsing();
    });
  });
});
