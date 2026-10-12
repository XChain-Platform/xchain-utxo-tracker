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
const BlockchainConnector = require('../../src/chain/blockchain_connector');

const TXID = '11'.repeat(32);
const MALFORMED_RESULTS = [
  { name: 'a non-string result', value: { hex: '00' } },
  { name: 'an odd-length string', value: 'abc' },
  { name: 'a non-hex string', value: '<html>busy</html>' }
];

describe('Integration: raw transaction result guard', function () {
  it('accepts whole hex from the same rpcPost boundary', async function () {
    const connector = new BlockchainConnector('127.0.0.1', '18443', 'user', 'pass');
    let calls = 0;

    connector.rpcPost = async function () {
      calls++;
      return { status: 200, data: { result: '00aaff' } };
    };

    expect(await connector.getRawTransaction(TXID)).to.equal('00aaff');
    expect(calls).to.equal(1);
  });

  for (const sample of MALFORMED_RESULTS) {
    it('rejects ' + sample.name + ' through wholeHexResult', async function () {
      const connector = new BlockchainConnector('127.0.0.1', '18443', 'user', 'pass');
      let calls = 0;

      connector.rpcPost = async function (request) {
        calls++;
        expect(request).to.deep.equal({
          jsonrpc: '2.0',
          method: 'getrawtransaction',
          params: [TXID],
          id: 1
        });
        return { status: 200, data: { result: sample.value } };
      };
      connector.sleep = async function () {};

      let failure;
      try {
        await connector.getRawTransaction(TXID);
      } catch (error) {
        failure = error;
      }

      expect(failure).to.be.an.instanceof(Error);
      expect(failure.message).to.include('expected whole hex');
      expect(failure.message).to.include(TXID);
      expect(calls).to.equal(10);
    });
  }
});
