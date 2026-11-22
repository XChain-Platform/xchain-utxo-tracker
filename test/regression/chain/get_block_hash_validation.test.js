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

// getBlockHash feeds the tip re-check and the reorg walk, which roll the UTXO set
// back on any mismatch with the stored (lowercase 64-hex) hash. It must therefore
// accept only a 64-hex string and lowercase it, like the decoder twin, so a
// malformed or case-changed answer fails into the caller's retry instead of
// reading as a fork.

const { expect } = require('chai');
const sinon = require('sinon');
const BlockchainConnector = require('../../../src/chain/blockchain_connector');

const HASH = 'ab12cd34'.repeat(8);

describe('getBlockHash accepts only a 64-hex block hash', function () {
  let connector, clientStub;

  beforeEach(function () {
    connector = new BlockchainConnector('127.0.0.1', '8332', 'rpcuser', 'rpcpass');
    clientStub = sinon.stub(connector.client, 'post');
  });
  afterEach(function () { sinon.restore(); });

  it('returns a valid 64-hex hash unchanged', async function () {
    clientStub.resolves({ data: { result: HASH } });
    expect(await connector.getBlockHash(7)).to.equal(HASH);
  });

  it('lowercases an upper-case 64-hex hash so it compares equal to the stored one', async function () {
    clientStub.resolves({ data: { result: HASH.toUpperCase() } });
    expect(await connector.getBlockHash(7)).to.equal(HASH);
  });

  const malformed = [
    ['an object', { hash: HASH }],
    ['a number', 12345],
    ['a short string', 'ab12'],
    ['a 63-char string', HASH.slice(1)],
    ['a 65-char string', HASH + 'a'],
    ['a non-hex 64-char string', 'g'.repeat(64)],
  ];
  for (const [label, result] of malformed) {
    it('rejects ' + label + ' instead of returning it as a hash', async function () {
      clientStub.resolves({ data: { result } });
      let caught = null;
      try { await connector.getBlockHash(7); } catch (e) { caught = e; }
      expect(caught, 'must throw').to.be.an('error');
      expect(caught.message).to.include('malformed result');
    });
  }
});
