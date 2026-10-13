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
const { createHash } = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const queries = require('../../../src/XChainUtxoTracker/address_queries.js');
const LTC = require('../../../src/coins/LTC.js');

// Regression: Litecoin Core issues P2SH addresses with version byte 0x3a ('Q')
// on test networks. Such an address must resolve to the same script as the
// legacy 0xc4 form of the same hash160, so confirmed outputs are queryable.
describe('LTC test-network P2SH version-2 address queries', function () {
  const nets = (LTC.networks || LTC.NETWORKS || LTC);
  const regtest = (nets.regtest && nets.regtest.net) || null;
  const mainnet = (nets.mainnet && nets.mainnet.net) || null;
  const hash = Buffer.alloc(20, 7);

  function stub(network) {
    const seen = [];
    return {
      network, seen, getAddressType: () => 'p2sh',
      db: {
        getOutputsScriptPubKey: async (h) => { seen.push(h); return []; },
        getOutputScriptBlock: async (h) => { seen.push(h); return null; },
      },
      mempoolDb: { getOutputsScriptPubKey: async (h) => { seen.push(h); return []; } },
    };
  }

  it('has the LTC regtest and mainnet network definitions', function () {
    expect(regtest, 'regtest net').to.be.an('object');
    expect(mainnet, 'mainnet net').to.be.an('object');
  });

  it('getFirstSeen resolves a 0x3a address against the same scriptHash as 0xc4', async function () {
    const q = Object.assign(stub(regtest), queries);
    const a = bitcoin.address.toBase58Check(hash, 0x3a);
    const b = bitcoin.address.toBase58Check(hash, 0xc4);
    expect(await q.getFirstSeen(a)).to.equal(null);
    expect(await q.getFirstSeen(b)).to.equal(null);
    expect(q.seen[0]).to.equal(q.seen[1]);
  });

  it('getBalanceInfo does not throw on a 0x3a address', async function () {
    const q = Object.assign(stub(regtest), queries);
    await q.getBalanceInfo(bitcoin.address.toBase58Check(hash, 0x3a));
    const script = bitcoin.address.toOutputScript(bitcoin.address.toBase58Check(hash, 0xc4), regtest);
    expect(q.seen[0]).to.equal(createHash('sha256').update(script).digest('hex'));
  });

  it('rejects garbage on regtest and a 0x3a address on mainnet', async function () {
    const q = Object.assign(stub(regtest), queries);
    let err = null;
    try { await q.getFirstSeen('not-an-address'); } catch (e) { err = e; }
    expect(err).to.be.an('error');
    const m = Object.assign(stub(mainnet), queries);
    err = null;
    try { await m.getFirstSeen(bitcoin.address.toBase58Check(hash, 0x3a)); } catch (e) { err = e; }
    expect(err).to.be.an('error');
    expect(err.message).to.match(/no matching Script/);
  });
});
