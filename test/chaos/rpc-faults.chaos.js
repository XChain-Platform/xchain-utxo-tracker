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
const {
  TEST_KEYS,
  makeCoinbaseTx, makeBlock,
  processAndCommit,
  createTestTracker, closeTracker, randHash,
  forceVerifyReorg, buildCommittedChain
} = require('./chaos-helpers');

describe('Chaos: RPC Faults', function () {
  let tracker;

  beforeEach(async function () {
    tracker = await createTestTracker();
    // Override sleep to avoid 3-second delays in verifyReorg retry loops
    tracker.sleep = async () => {};
  });

  afterEach(async function () {
    sinon.restore();
    await closeTracker(tracker);
  });

  describe('Exp 4: RPC Connection Loss', function () {

    it('verifyReorg retries after transient RPC failures and succeeds', async function () {
      const blocks = await buildCommittedChain(tracker, 5);

      let calls = 0;
      sinon.stub(tracker.connector, 'getBlockHash').callsFake(async (height) => {
        calls++;
        if (calls <= 3) throw new Error('connect ECONNREFUSED 127.0.0.1:18443');
        return blocks[height].hash;
      });

      await forceVerifyReorg(tracker);

      // Height unchanged: no reorg occurred, just transient failures
      expect(await tracker.db.getLastBlockHeight()).to.equal(4);
      expect(await tracker.db.getLastBlockHash()).to.equal(blocks[4].hash);

      // Stub was called at least 4 times (3 failures + 1 success)
      expect(calls).to.be.at.least(4);
    });

    it('stale-but-consistent data remains queryable during RPC outage', async function () {
      const blocks = await buildCommittedChain(tracker, 5, 0);

      sinon.stub(tracker.connector, 'getBlockHash')
        .rejects(new Error('ECONNREFUSED'));

      // Balance queries only hit LevelDB, not RPC
      const info = await tracker.getBalanceInfo(TEST_KEYS[0].address);
      expect(info.balances.confirmed).to.equal('250.00000000');
    });

    it('resumes correctly after prolonged RPC outage', async function () {
      const blocks = await buildCommittedChain(tracker, 3);

      let calls = 0;
      sinon.stub(tracker.connector, 'getBlockHash').callsFake(async (height) => {
        calls++;
        if (calls <= 10) throw new Error('ETIMEDOUT');
        return blocks[height].hash;
      });

      await forceVerifyReorg(tracker);

      expect(await tracker.db.getLastBlockHeight()).to.equal(2);
      expect(calls).to.be.at.least(11);
    });
  });

  describe('Exp 5a: Null RPC Response', function () {

    it('null getBlockHash response triggers retry, eventually succeeds', async function () {
      const blocks = await buildCommittedChain(tracker, 5);

      let calls = 0;
      sinon.stub(tracker.connector, 'getBlockHash').callsFake(async (height) => {
        calls++;
        // A null (malformed) response won't match the stored hash, so it
        // causes a phantom rollback of one block before subsequent calls succeed.
        if (calls === 1) return null;
        return blocks[height].hash;
      });

      await forceVerifyReorg(tracker);

      const finalHeight = await tracker.db.getLastBlockHeight();
      expect(finalHeight).to.equal(3);

      // Block 4 was deleted by the phantom rollback
      expect(await tracker.db.getBlock(blocks[4].hash)).to.be.null;

      for (let i = 0; i <= 3; i++) {
        expect(await tracker.db.getBlock(blocks[i].hash)).to.not.be.null;
      }
    });
  });

  describe('Exp 5b: Truncated Hash Response', function () {

    it('truncated hash causes phantom reorg (documents weakness)', async function () {
      const blocks = await buildCommittedChain(tracker, 5);

      const truncatedHash = 'ab'.repeat(15); // 30 hex chars instead of 64

      let calls = 0;
      sinon.stub(tracker.connector, 'getBlockHash').callsFake(async (height) => {
        calls++;
        if (calls === 1) return truncatedHash;
        return blocks[height].hash;
      });

      await forceVerifyReorg(tracker);

      const finalHeight = await tracker.db.getLastBlockHeight();
      expect(finalHeight).to.equal(3);

      // Documents a weakness: a single malformed node response can cause a
      // 1-block rollback. The system recovers but that block must be re-indexed.
    });
  });

  describe('Exp 5c: Alternating valid/invalid responses', function () {

    it('intermittent malformed responses cause progressive rollback then stabilize', async function () {
      const blocks = await buildCommittedChain(tracker, 8);

      let calls = 0;
      sinon.stub(tracker.connector, 'getBlockHash').callsFake(async (height) => {
        calls++;
        // Simulates a flaky proxy returning garbage intermittently
        if (calls <= 2) return randHash(); // wrong hash → rollback
        return blocks[height].hash;
      });

      await forceVerifyReorg(tracker);

      // Two phantom rollbacks occurred (blocks 7 and 6), then stabilized at 5
      const finalHeight = await tracker.db.getLastBlockHeight();
      expect(finalHeight).to.be.at.most(6);
      expect(finalHeight).to.be.at.least(4);

      const finalHash = await tracker.db.getLastBlockHash();
      const block = await tracker.db.getBlock(finalHash);
      expect(block).to.not.be.null;
      expect(block.h).to.equal(finalHeight);
    });
  });

  describe('Exp 5d: RPC response after recovering from errors', function () {

    it('new blocks can be indexed after RPC recovery', async function () {
      const blocks = await buildCommittedChain(tracker, 3);

      let calls = 0;
      sinon.stub(tracker.connector, 'getBlockHash').callsFake(async (height) => {
        calls++;
        if (calls <= 2) throw new Error('ECONNRESET');
        return blocks[height].hash;
      });

      await forceVerifyReorg(tracker);
      sinon.restore();

      const block3 = makeBlock(3, blocks[2].hash, [makeCoinbaseTx(1, 25 * 100000000)]);
      await processAndCommit(tracker, block3);

      expect(await tracker.db.getLastBlockHeight()).to.equal(3);
      const info = await tracker.getBalanceInfo(TEST_KEYS[1].address);
      expect(info.balances.confirmed).to.equal('25.00000000');
    });
  });
});
