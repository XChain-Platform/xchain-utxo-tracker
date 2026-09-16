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
const crypto = require('crypto');
const LevelUpStore = require('../../../src/store/level_up_db');

function randHash() { return crypto.randomBytes(32).toString('hex'); }
function randHash8() { return crypto.randomBytes(8).toString('hex'); }

// 7. Output hint and removal (REMOVE_SPENT path)
describe('Boundary: Output hint and removal', function () {
  let db;

  beforeEach(async function () {
    db = new LevelUpStore('boundary-hint-' + Date.now(), true);
    await db.createDatabase();
  });

  afterEach(async function () {
    try { await db.close(); } catch (e) {}
  });

  it('removeOutputWithInput removes an output and its hint', async function () {
    const scriptHash = randHash();
    const txHash8 = randHash8();
    const blockHash = randHash();
    const fullTxHash = txHash8 + randHash().substring(16);

    await db.beginTransaction();
    await db.insertOutput({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 0, value: 5000000000, height: 1, fullTxHash });
    await db.insertOutputHint({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 0 });
    await db.endTransaction();

    await db.beginTransaction();
    await db.removeOutputWithInput({ prevTxHash: txHash8, prevOutputIndex: 0, blockHash });
    await db.endTransaction();

    const outputs = await db.getOutputsScriptPubKey(scriptHash);
    expect(outputs).to.have.length(0);
  });
  it('removeOutputWithInput finds same-block output in transactionArray', async function () {
    const scriptHash = randHash();
    const txHash8 = randHash8();
    const blockHash = randHash();
    const fullTxHash = txHash8 + randHash().substring(16);

    // Insert and spend within the same uncommitted batch.
    await db.beginTransaction();
    await db.insertOutput({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 0, value: 5000000000, height: 1, fullTxHash });
    await db.insertOutputHint({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 0 });
    await db.removeOutputWithInput({ prevTxHash: txHash8, prevOutputIndex: 0, blockHash });
    await db.endTransaction();

    const outputs = await db.getOutputsScriptPubKey(scriptHash);
    expect(outputs).to.have.length(0);
  });
});

describe('Boundary: Output hint and removal', function () {
  let db;

  beforeEach(async function () {
    db = new LevelUpStore('boundary-hint-' + Date.now(), true);
    await db.createDatabase();
  });

  afterEach(async function () {
    try { await db.close(); } catch (e) {}
  });

  it('deletion is recoverable via processDeletedOutputs', async function () {
    const scriptHash = randHash();
    const txHash8 = randHash8();
    const blockHash = randHash();
    const fullTxHash = txHash8 + randHash().substring(16);

    // Insert the output and commit it, so the spend below has real committed
    // state to delete rather than a staged record it can just drop.
    await db.beginTransaction();
    await db.insertOutput({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 0, value: 5000000000, height: 1, fullTxHash });
    await db.insertOutputHint({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 0 });
    await db.endTransaction();

    // Spend it (creates K/M records).
    await db.beginTransaction();
    await db.removeOutputWithInput({ prevTxHash: txHash8, prevOutputIndex: 0, blockHash });
    await db.endTransaction();

    // Verify it's gone
    let outputs = await db.getOutputsScriptPubKey(scriptHash);
    expect(outputs).to.have.length(0);

    // Recover via processDeletedOutputs (reorg simulation).
    await db.beginTransaction();
    await db.processDeletedOutputs(blockHash, true);
    await db.endTransaction();

    outputs = await db.getOutputsScriptPubKey(scriptHash);
    expect(outputs).to.have.length(1);
    expect(outputs[0].value).to.equal('5000000000');
  });
});
