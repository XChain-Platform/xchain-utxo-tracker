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
const LevelUpStore = require('../../src/store/level_up_db');

// Exercise the REAL exported conversion (restored as exact BigInt in src after the
// a2774ac float regression), so these precision tests actually guard the source.
const { satoshiToDecimalString } = require('../../src/XChainUtxoTracker');

function randHash() { return crypto.randomBytes(32).toString('hex'); }
function randHash8() { return crypto.randomBytes(8).toString('hex'); }

// 1. satoshiToDecimalString precision
describe('Boundary: satoshiToDecimalString', function () {

  it('converts zero', function () {
    expect(satoshiToDecimalString(0)).to.equal('0.00000000');
    expect(satoshiToDecimalString(0n)).to.equal('0.00000000');
    expect(satoshiToDecimalString('0')).to.equal('0.00000000');
  });
  it('converts one satoshi', function () {
    expect(satoshiToDecimalString(1)).to.equal('0.00000001');
  });
  it('converts 1 BTC', function () {
    expect(satoshiToDecimalString(100000000)).to.equal('1.00000000');
    expect(satoshiToDecimalString(100000000n)).to.equal('1.00000000');
  });
  it('converts 50 BTC (typical coinbase)', function () {
    expect(satoshiToDecimalString(5000000000n)).to.equal('50.00000000');
  });
  it('converts fractional amounts correctly', function () {
    expect(satoshiToDecimalString(123456789)).to.equal('1.23456789');
  });
  it('handles Dogecoin-scale values (100M DOGE)', function () {
    // 100,000,000 DOGE = 10,000,000,000,000,000 satoshis
    const val = 10000000000000000n;
    expect(satoshiToDecimalString(val)).to.equal('100000000.00000000');
  });
  it('handles values above Number.MAX_SAFE_INTEGER without precision loss', function () {
    // Number.MAX_SAFE_INTEGER = 9007199254740991
    // As a float: 9007199254740991 / 100000000 = 90071992.54740991
    // BigInt should produce exact result
    const val = '9007199254740991';
    expect(satoshiToDecimalString(val)).to.equal('90071992.54740991');
  });
  it('handles uint64 max (theoretical maximum)', function () {
    const val = '18446744073709551615'; // 2^64 - 1
    expect(satoshiToDecimalString(val)).to.equal('184467440737.09551615');
  });
  it('handles negative balances (pending outflows)', function () {
    expect(satoshiToDecimalString(-5000000000n)).to.equal('-50.00000000');
    expect(satoshiToDecimalString(-1n)).to.equal('-0.00000001');
  });
  it('handles negative fractional amounts', function () {
    expect(satoshiToDecimalString(-123456789n)).to.equal('-1.23456789');
  });
  it('pads fractional part to 8 digits', function () {
    expect(satoshiToDecimalString(10n)).to.equal('0.00000010');
    expect(satoshiToDecimalString(100n)).to.equal('0.00000100');
    expect(satoshiToDecimalString(10000000n)).to.equal('0.10000000');
  });
  it('accepts string input', function () {
    expect(satoshiToDecimalString('5000000000')).to.equal('50.00000000');
  });
});

// 2. Value encoding/decoding at boundaries
describe('Boundary: Output value encoding/decoding', function () {
  let db;

  beforeEach(async function () {
    db = new LevelUpStore('boundary-val-' + Date.now(), true);
    await db.createDatabase();
  });

  afterEach(async function () {
    try { await db.close(); } catch (e) {}
  });

  it('round-trips zero value output', async function () {
    const scriptHash = randHash();
    const txHash8 = randHash8();

    await db.beginTransaction();
    await db.insertOutput({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 0, value: 0, height: 100, fullTxHash: txHash8 + randHash().substring(16) });
    await db.endTransaction();

    const outputs = await db.getOutputsScriptPubKey(scriptHash);
    expect(outputs).to.have.length(1);
    expect(outputs[0].value).to.equal('0');
  });
  it('round-trips one satoshi value', async function () {
    const scriptHash = randHash();
    const txHash8 = randHash8();

    await db.beginTransaction();
    await db.insertOutput({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 0, value: 1, height: 100, fullTxHash: txHash8 + randHash().substring(16) });
    await db.endTransaction();

    const outputs = await db.getOutputsScriptPubKey(scriptHash);
    expect(outputs[0].value).to.equal('1');
  });
  it('round-trips 50 BTC (5,000,000,000 satoshis)', async function () {
    const scriptHash = randHash();
    const txHash8 = randHash8();

    await db.beginTransaction();
    await db.insertOutput({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 0, value: 5000000000, height: 100, fullTxHash: txHash8 + randHash().substring(16) });
    await db.endTransaction();

    const outputs = await db.getOutputsScriptPubKey(scriptHash);
    expect(outputs[0].value).to.equal('5000000000');
  });
  it('round-trips Dogecoin-scale value (10^16 satoshis)', async function () {
    const scriptHash = randHash();
    const txHash8 = randHash8();
    const bigVal = '10000000000000000'; // 100M DOGE

    await db.beginTransaction();
    await db.insertOutput({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 0, value: bigVal, height: 100, fullTxHash: txHash8 + randHash().substring(16) });
    await db.endTransaction();

    const outputs = await db.getOutputsScriptPubKey(scriptHash);
    expect(outputs[0].value).to.equal(bigVal);
  });
});

describe('Boundary: Output value encoding/decoding', function () {
  let db;

  beforeEach(async function () {
    db = new LevelUpStore('boundary-val-' + Date.now(), true);
    await db.createDatabase();
  });

  afterEach(async function () {
    try { await db.close(); } catch (e) {}
  });

  it('round-trips uint64 max value', async function () {
    const scriptHash = randHash();
    const txHash8 = randHash8();
    const maxUint64 = '18446744073709551615'; // 2^64 - 1

    await db.beginTransaction();
    await db.insertOutput({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 0, value: maxUint64, height: 100, fullTxHash: txHash8 + randHash().substring(16) });
    await db.endTransaction();

    const outputs = await db.getOutputsScriptPubKey(scriptHash);
    expect(outputs[0].value).to.equal(maxUint64);
  });
});

// 3. Height encoding at boundaries
describe('Boundary: Height encoding/decoding', function () {
  let db;

  beforeEach(async function () {
    db = new LevelUpStore('boundary-height-' + Date.now(), true);
    await db.createDatabase();
  });

  afterEach(async function () {
    try { await db.close(); } catch (e) {}
  });

  it('encodes height 0 (genesis block) correctly', async function () {
    const hash = randHash();
    await db.beginTransaction();
    await db.insertBlock({ hash, height: 0, timestamp: 1231006505, previousHash: '0'.repeat(64) });
    await db.endTransaction();

    const block = await db.getBlock(hash);
    expect(block.h).to.equal(0);
  });
  it('encodes mempool height -1 correctly in output values', async function () {
    const scriptHash = randHash();
    const txHash8 = randHash8();

    await db.beginTransaction();
    await db.insertOutput({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 0, value: 100000000, height: -1, fullTxHash: txHash8 + randHash().substring(16) });
    await db.endTransaction();

    const outputs = await db.getOutputsScriptPubKey(scriptHash);
    expect(outputs[0].height).to.equal(-1);
  });
  it('encodes null height as -1', async function () {
    const scriptHash = randHash();
    const txHash8 = randHash8();

    await db.beginTransaction();
    await db.insertOutput({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 0, value: 100000000, height: null, fullTxHash: txHash8 + randHash().substring(16) });
    await db.endTransaction();

    const outputs = await db.getOutputsScriptPubKey(scriptHash);
    expect(outputs[0].height).to.equal(-1);
  });
  it('does not confuse mempool -1 with large positive height', async function () {
    const scriptHash = randHash();
    const txHash8 = randHash8();

    await db.beginTransaction();
    await db.insertOutput({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 0, value: 100000000, height: -1, fullTxHash: txHash8 + randHash().substring(16) });
    await db.endTransaction();

    const outputs = await db.getOutputsScriptPubKey(scriptHash);
    // If height were read as UInt32 instead of Int32, -1 would appear as 4294967295
    expect(outputs[0].height).to.not.equal(4294967295);
    expect(outputs[0].height).to.equal(-1);
  });
});

describe('Boundary: Height encoding/decoding', function () {
  let db;

  beforeEach(async function () {
    db = new LevelUpStore('boundary-height-' + Date.now(), true);
    await db.createDatabase();
  });

  afterEach(async function () {
    try { await db.close(); } catch (e) {}
  });

  it('encodes large block height (2,147,483,647 = INT32_MAX)', async function () {
    const hash = randHash();
    // Block height stored as UInt32, so this is within range
    await db.beginTransaction();
    await db.insertBlock({ hash, height: 2147483647, timestamp: 4294967295, previousHash: randHash() });
    await db.endTransaction();

    const block = await db.getBlock(hash);
    expect(block.h).to.equal(2147483647);
  });
});

// 4. TxID and Vout boundary encoding
describe('Boundary: TxID and Vout encoding', function () {
  let db;

  beforeEach(async function () {
    db = new LevelUpStore('boundary-txid-' + Date.now(), true);
    await db.createDatabase();
  });

  afterEach(async function () {
    try { await db.close(); } catch (e) {}
  });

  it('stores and retrieves output with vout = 0', async function () {
    const scriptHash = randHash();
    const txHash8 = randHash8();

    await db.beginTransaction();
    await db.insertOutput({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 0, value: 100000000, height: 1, fullTxHash: txHash8 + randHash().substring(16) });
    await db.endTransaction();

    const outputs = await db.getOutputsScriptPubKey(scriptHash);
    expect(outputs[0].vout).to.equal(0);
  });
  it('stores and retrieves output with large vout (2999)', async function () {
    const scriptHash = randHash();
    const txHash8 = randHash8();

    await db.beginTransaction();
    await db.insertOutput({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 2999, value: 100000000, height: 1, fullTxHash: txHash8 + randHash().substring(16) });
    await db.endTransaction();

    const outputs = await db.getOutputsScriptPubKey(scriptHash);
    expect(outputs[0].vout).to.equal(2999);
  });
  it('stores and retrieves output with vout at UInt32 max boundary (4294967294)', async function () {
    // 4294967295 (0xFFFFFFFF) is reserved for coinbase; test one below
    const scriptHash = randHash();
    const txHash8 = randHash8();

    await db.beginTransaction();
    await db.insertOutput({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 4294967294, value: 100000000, height: 1, fullTxHash: txHash8 + randHash().substring(16) });
    await db.endTransaction();

    const outputs = await db.getOutputsScriptPubKey(scriptHash);
    expect(outputs[0].vout).to.equal(4294967294);
  });
  it('stores all-zero txHash8 correctly', async function () {
    const scriptHash = randHash();
    const txHash8 = '0'.repeat(16);

    await db.beginTransaction();
    await db.insertOutput({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 0, value: 100000000, height: 1, fullTxHash: '0'.repeat(64) });
    await db.endTransaction();

    const outputs = await db.getOutputsScriptPubKey(scriptHash);
    expect(outputs[0].txid).to.equal(txHash8);
  });
});

describe('Boundary: TxID and Vout encoding', function () {
  let db;

  beforeEach(async function () {
    db = new LevelUpStore('boundary-txid-' + Date.now(), true);
    await db.createDatabase();
  });

  afterEach(async function () {
    try { await db.close(); } catch (e) {}
  });

  it('stores all-ff txHash8 correctly', async function () {
    const scriptHash = randHash();
    const txHash8 = 'f'.repeat(16);

    await db.beginTransaction();
    await db.insertOutput({ scriptPubKey: scriptHash, txHash: txHash8, outputIndex: 0, value: 100000000, height: 1, fullTxHash: 'f'.repeat(64) });
    await db.endTransaction();

    const outputs = await db.getOutputsScriptPubKey(scriptHash);
    expect(outputs[0].txid).to.equal(txHash8);
  });
  it('disambiguates two txids sharing the same txHash8 prefix', async function () {
    const scriptHash = randHash();
    const sharedPrefix = randHash8();
    const fullTxid1 = sharedPrefix + 'a'.repeat(48);
    const fullTxid2 = sharedPrefix + 'b'.repeat(48);

    await db.beginTransaction();
    await db.insertOutput({ scriptPubKey: scriptHash, txHash: sharedPrefix, outputIndex: 0, value: 100000000, height: 1, fullTxHash: fullTxid1 });
    await db.insertOutput({ scriptPubKey: scriptHash, txHash: sharedPrefix, outputIndex: 1, value: 200000000, height: 1, fullTxHash: fullTxid2 });
    await db.endTransaction();

    const outputs = await db.getOutputsScriptPubKey(scriptHash);
    expect(outputs).to.have.length(2);
    const txids = outputs.map(o => o.fullTxid).sort();
    expect(txids).to.deep.equal([fullTxid1, fullTxid2].sort());
  });
});
