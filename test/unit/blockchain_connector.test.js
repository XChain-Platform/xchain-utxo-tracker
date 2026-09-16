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
const BlockchainConnector = require('../../src/chain/blockchain_connector');

let connector;
let clientStub;

function registerConnectorHooks() {
  beforeEach(function () {
    connector = new BlockchainConnector('127.0.0.1', '8332', 'user', 'pass');
    clientStub = sinon.stub(connector.client, 'post');
  });

  afterEach(function () {
    sinon.restore();
  });
}

function registerConstructorTests() {
  describe('constructor', function () {
    it('builds the correct base URL', function () {
      expect(connector.url).to.equal('http://127.0.0.1:8332');
    });

    it('stores port and credentials', function () {
      expect(connector.port).to.equal('8332');
      expect(connector.rpcUser).to.equal('user');
      expect(connector.rpcPassword).to.equal('pass');
    });
  });
}

function registerBlockchainInfoTests() {
  describe('getBlockchainInfo', function () {
    it('returns result on success', async function () {
      const mockResult = { blocks: 800000, headers: 800000, verificationprogress: 1.0 };
      clientStub.resolves({ data: { result: mockResult } });

      const info = await connector.getBlockchainInfo();
      expect(info).to.deep.equal(mockResult);
      expect(clientStub.calledOnce).to.be.true;

      const payload = clientStub.firstCall.args[1];
      expect(payload.method).to.equal('getblockchaininfo');
    });

    it('throws when result is null', async function () {
      clientStub.resolves({ data: { result: null } });
      try {
        await connector.getBlockchainInfo();
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.message).to.include('blockchain info');
      }
    });
  });
}

function registerBlockHashTests() {
  describe('getBlockHash', function () {
    it('returns hash for valid height', async function () {
      const hash = '0000000000000000000abc123';
      clientStub.resolves({ data: { result: hash } });

      const result = await connector.getBlockHash(0);
      expect(result).to.equal(hash);

      const payload = clientStub.firstCall.args[1];
      expect(payload.params).to.deep.equal([0]);
    });

    it('throws when result is null', async function () {
      clientStub.resolves({ data: { result: null } });
      try {
        await connector.getBlockHash(999999999);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.message).to.include('block hash');
      }
    });

    it('rethrows network errors', async function () {
      clientStub.rejects(new Error('ECONNREFUSED'));
      try {
        await connector.getBlockHash(0);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.message).to.include('ECONNREFUSED');
      }
    });
  });
}

function registerBlockTests() {
  describe('getBlock', function () {
    it('returns hex when hexFormat=true (default)', async function () {
      clientStub.resolves({ data: { result: '0100000000000000...' } });
      const hex = await connector.getBlock('abc123');
      expect(hex).to.be.a('string');

      // hexFormat=true → pass boolean false to getblock for hex. getblock's
      // verbose arg is a boolean (false=hex, true=json), matching getblockheader;
      // Dogecoin Core 1.14 rejects an integer verbosity here.
      const payload = clientStub.firstCall.args[1];
      expect(payload.params[1]).to.equal(false);
    });

    it('returns object when hexFormat=false', async function () {
      const blockObj = { hash: 'abc', tx: [] };
      clientStub.resolves({ data: { result: blockObj } });
      const result = await connector.getBlock('abc', false);
      expect(result).to.deep.equal(blockObj);
    });

    it('retries on ECONNABORTED timeout (matches getBlockHeader)', async function () {
      sinon.stub(connector, 'sleep').resolves();
      const timeoutErr = new Error('timeout');
      timeoutErr.code = 'ECONNABORTED';

      clientStub.onCall(0).rejects(timeoutErr);
      clientStub.onCall(1).rejects(timeoutErr);
      clientStub.onCall(2).resolves({ data: { result: 'blockhex' } });

      const result = await connector.getBlock('abc');
      expect(result).to.equal('blockhex');
      expect(clientStub.callCount).to.equal(3);
    });

    it('throws immediately on non-timeout error', async function () {
      clientStub.rejects(new Error('connection refused'));
      try {
        await connector.getBlock('abc');
        expect.fail('should have thrown');
      } catch (err) {
        expect(clientStub.callCount).to.equal(1);
      }
    });
  });
}

function registerBlockHeaderTests() {
  describe('getBlockHeader', function () {
    it('returns header on success', async function () {
      clientStub.resolves({ data: { result: '01000000...' } });
      const header = await connector.getBlockHeader('abc123');
      expect(header).to.equal('01000000...');
    });

    it('retries on ECONNABORTED timeout', async function () {
      sinon.stub(connector, 'sleep').resolves();  // skip the real 500ms backoff
      const timeoutErr = new Error('timeout');
      timeoutErr.code = 'ECONNABORTED';

      clientStub.onCall(0).rejects(timeoutErr);
      clientStub.onCall(1).rejects(timeoutErr);
      clientStub.onCall(2).resolves({ data: { result: 'headerdata' } });

      const result = await connector.getBlockHeader('abc');
      expect(result).to.equal('headerdata');
      expect(clientStub.callCount).to.equal(3);
      // Backoff applied between the two failed attempts (no hot-spin).
      expect(connector.sleep.callCount).to.equal(2);
    });

    it('throws after 10 timeout retries, backing off between each', async function () {
      const sleepStub = sinon.stub(connector, 'sleep').resolves();
      const timeoutErr = new Error('timeout');
      timeoutErr.code = 'ECONNABORTED';
      clientStub.rejects(timeoutErr);

      try {
        await connector.getBlockHeader('abc');
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.message).to.include('problems getting a block hex');
        expect(clientStub.callCount).to.equal(10);
        // 9 backoffs across 10 attempts (none after the final attempt).
        expect(sleepStub.callCount).to.equal(9);
      }
    });

    it('throws immediately on non-timeout error', async function () {
      clientStub.rejects(new Error('connection refused'));
      try {
        await connector.getBlockHeader('abc');
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.message).to.include('connection refused');
        expect(clientStub.callCount).to.equal(1);
      }
    });
  });
}

describe('BlockchainConnector', function () {
  registerConnectorHooks();
  registerConstructorTests();
  registerBlockchainInfoTests();
  registerBlockHashTests();
  registerBlockTests();
  registerBlockHeaderTests();
});
