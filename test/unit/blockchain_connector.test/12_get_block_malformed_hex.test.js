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

// A hex-mode getblock answer that is not whole hex is a wire fault: both the
// batched and the single read refuse it, so the caller retries the fetch instead
// of the parser meeting a buffer that Buffer.from(hex, 'hex') silently truncated.

const { expect } = require('chai');
const sinon = require('sinon');
const BlockchainConnector = require('../../../src/chain/blockchain_connector');

const GOOD = 'ab12'.repeat(40);
const MALFORMED = [
  ['odd length', GOOD + 'a'],
  ['non-hex characters', GOOD.slice(0, 20) + 'zz' + GOOD.slice(22)],
  ['an object', { tx: [] }],
  ['a number', 12345]
];

let connector;
let clientStub;

describe('BlockchainConnector malformed getblock hex', function () {
  beforeEach(function () {
    connector = new BlockchainConnector('127.0.0.1', '8332', 'user', 'pass');
    clientStub = sinon.stub(connector.client, 'post');
  });

  afterEach(function () {
    sinon.restore();
  });

  describe('getBlocksBatch', function () {
    for (const [label, bad] of MALFORMED) {
      it('refuses a batched reply that is ' + label + ', naming the height and hash', async function () {
        clientStub.onCall(0).resolves({ data: [{ id: 0, result: 'h10' }, { id: 1, result: 'h11' }] });
        clientStub.onCall(1).resolves({ data: [{ id: 0, result: GOOD }, { id: 1, result: bad }] });
        let caught = null;
        try { await connector.getBlocksBatch([10, 11]); } catch (e) { caught = e; }
        expect(caught).to.be.an('error');
        expect(caught.message).to.match(/^getblock returned malformed block hex for block 11 \(h11\) in batch/);
        expect(caught.auxPowParseFailure).to.equal(undefined);
      });
    }

    it('still returns whole hex untouched', async function () {
      clientStub.onCall(0).resolves({ data: [{ id: 0, result: 'h10' }] });
      clientStub.onCall(1).resolves({ data: [{ id: 0, result: GOOD }] });
      const out = await connector.getBlocksBatch([10]);
      expect(out).to.deep.equal([{ height: 10, hash: 'h10', hex: GOOD }]);
    });
  });

  describe('getBlock', function () {
    for (const [label, bad] of MALFORMED) {
      it('refuses a hex-mode reply that is ' + label, async function () {
        clientStub.resolves({ data: { result: bad } });
        let caught = null;
        try { await connector.getBlock('h10'); } catch (e) { caught = e; }
        expect(caught).to.be.an('error');
        expect(caught.message).to.match(/^getblock returned malformed block hex for h10 \(/);
      });
    }

    it('leaves the verbose object of hexFormat=false alone', async function () {
      clientStub.resolves({ data: { result: { hash: 'h10', tx: [] } } });
      const out = await connector.getBlock('h10', false);
      expect(out).to.deep.equal({ hash: 'h10', tx: [] });
    });
  });
});
