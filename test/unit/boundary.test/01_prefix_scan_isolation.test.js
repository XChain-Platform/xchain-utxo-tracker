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

// 5. LevelDB prefix scan boundaries
describe('Boundary: Prefix scan isolation', function () {
  let db;

  beforeEach(async function () {
    db = new LevelUpStore('boundary-scan-' + Date.now(), true);
    await db.createDatabase();
  });

  afterEach(async function () {
    try { await db.close(); } catch (e) {}
  });

  it('returns empty array for scriptHash with no outputs', async function () {
    const scriptHash = randHash();
    const outputs = await db.getOutputsScriptPubKey(scriptHash);
    expect(outputs).to.be.an('array').with.length(0);
  });
  it('does not leak records from adjacent scriptHash prefixes', async function () {
    const scriptHash1 = '00' + randHash().substring(2);
    const scriptHash2 = '01' + randHash().substring(2);
    const txHash8 = randHash8();

    await db.beginTransaction();
    await db.insertOutput({ scriptPubKey: scriptHash1, txHash: txHash8, outputIndex: 0, value: 100000000, height: 1, fullTxHash: txHash8 + randHash().substring(16) });
    await db.insertOutput({ scriptPubKey: scriptHash2, txHash: txHash8, outputIndex: 0, value: 200000000, height: 1, fullTxHash: txHash8 + randHash().substring(16) });
    await db.endTransaction();

    const outputs1 = await db.getOutputsScriptPubKey(scriptHash1);
    expect(outputs1).to.have.length(1);
    expect(outputs1[0].value).to.equal('100000000');

    const outputs2 = await db.getOutputsScriptPubKey(scriptHash2);
    expect(outputs2).to.have.length(1);
    expect(outputs2[0].value).to.equal('200000000');
  });
  it('handles all-zero scriptHash prefix correctly', async function () {
    const scriptHash = '0'.repeat(64);
    const txHash8 = randHash8();

    await db.beginTransaction();
    await db.insertOutput({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 0, value: 100000000, height: 1, fullTxHash: txHash8 + randHash().substring(16) });
    await db.endTransaction();

    const outputs = await db.getOutputsScriptPubKey(scriptHash);
    expect(outputs).to.have.length(1);
  });
  it('handles all-ff scriptHash prefix correctly', async function () {
    const scriptHash = 'f'.repeat(64);
    const txHash8 = randHash8();

    await db.beginTransaction();
    await db.insertOutput({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 0, value: 100000000, height: 1, fullTxHash: txHash8 + randHash().substring(16) });
    await db.endTransaction();

    const outputs = await db.getOutputsScriptPubKey(scriptHash);
    expect(outputs).to.have.length(1);
  });
});

describe('Boundary: Prefix scan isolation', function () {
  let db;

  beforeEach(async function () {
    db = new LevelUpStore('boundary-scan-' + Date.now(), true);
    await db.createDatabase();
  });

  afterEach(async function () {
    try { await db.close(); } catch (e) {}
  });

  it('returns exactly one result for single UTXO', async function () {
    const scriptHash = randHash();
    const txHash8 = randHash8();

    await db.beginTransaction();
    await db.insertOutput({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 0, value: 100000000, height: 1, fullTxHash: txHash8 + randHash().substring(16) });
    await db.endTransaction();

    const outputs = await db.getOutputsScriptPubKey(scriptHash);
    expect(outputs).to.have.length(1);
  });
});
