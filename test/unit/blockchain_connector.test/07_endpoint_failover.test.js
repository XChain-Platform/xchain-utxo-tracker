'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const { expect } = require('chai');
const sinon = require('sinon');
const BlockchainConnector = require('../../../src/chain/blockchain_connector');

function connectionError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

async function expectRejection(promise) {
  let thrown;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }
  expect(thrown).to.be.an('error');
}

function makeConnector(fallback, threshold) {
  if (fallback !== undefined) process.env.NODE_URL_FALLBACK = fallback;
  if (threshold !== undefined) process.env.NODE_FAILOVER_THRESHOLD = String(threshold);
  return new BlockchainConnector('127.0.0.1', '8332', 'user', 'pass');
}

describe('BlockchainConnector endpoint failover', function () {
  let connector;
  let clientStub;

  afterEach(function () {
    sinon.restore();
    delete process.env.NODE_URL_FALLBACK;
    delete process.env.NODE_FAILOVER_THRESHOLD;
  });

  describe('endpoint parsing', function () {
    it('uses only the primary endpoint when fallbacks are unset', function () {
      connector = makeConnector();
      expect(connector.endpoints).to.deep.equal(['http://127.0.0.1:8332']);
      expect(connector.url).to.equal('http://127.0.0.1:8332');
    });

    it('parses fallback hosts with default and explicit ports and protocols', function () {
      connector = makeConnector('10.0.0.2, 10.0.0.3:9332, https://node.example.com');
      expect(connector.endpoints).to.deep.equal([
        'http://127.0.0.1:8332',
        'http://10.0.0.2:8332',
        'http://10.0.0.3:9332',
        'https://node.example.com:8332'
      ]);
    });

    it('ignores an empty fallback list', function () {
      connector = makeConnector('');
      expect(connector.endpoints).to.have.length(1);
    });

    it('rejects malformed fallback entries', function () {
      expect(() => makeConnector('ht!tp://bad url')).to.throw(/invalid RPC endpoint/);
    });
  });

  describe('rotation', function () {
    beforeEach(function () {
      connector = makeConnector('10.0.0.2', 3);
      clientStub = sinon.stub(connector.client, 'post');
      sinon.stub(console, 'warn');
    });

    it('rotates after consecutive connection failures and uses the fallback next', async function () {
      clientStub.rejects(connectionError('ECONNREFUSED'));
      for (let i = 0; i < 3; i++) {
        await expectRejection(connector.getBlockchainInfo());
      }

      expect(connector.url).to.equal('http://10.0.0.2:8332');
      clientStub.resolves({ data: { result: { blocks: 7 } } });
      expect(await connector.getBlockchainInfo()).to.deep.equal({ blocks: 7 });
      expect(clientStub.lastCall.args[0]).to.equal('http://10.0.0.2:8332');
    });

    it('resets the streak after a successful response', async function () {
      clientStub.rejects(connectionError('ECONNREFUSED'));
      await expectRejection(connector.getBlockchainInfo());
      await expectRejection(connector.getBlockchainInfo());

      clientStub.resolves({ data: { result: {} } });
      await connector.getBlockchainInfo();

      clientStub.rejects(connectionError('ECONNREFUSED'));
      await expectRejection(connector.getBlockchainInfo());
      await expectRejection(connector.getBlockchainInfo());
      expect(connector.url).to.equal('http://127.0.0.1:8332');
    });

    it('resets the streak after an HTTP response from the node', async function () {
      clientStub.rejects(connectionError('ECONNREFUSED'));
      await expectRejection(connector.getBlockchainInfo());
      await expectRejection(connector.getBlockchainInfo());

      const httpError = new Error('HTTP 500');
      httpError.response = { status: 500, data: { error: { code: -32603 } } };
      clientStub.rejects(httpError);
      await expectRejection(connector.getBlockchainInfo());

      clientStub.rejects(connectionError('ECONNREFUSED'));
      await expectRejection(connector.getBlockchainInfo());
      await expectRejection(connector.getBlockchainInfo());
      expect(connector.url).to.equal('http://127.0.0.1:8332');
    });

    it('rotates inside an existing timeout retry loop', async function () {
      connector.failoverThreshold = 2;
      sinon.stub(connector, 'sleep').resolves();
      clientStub.onCall(0).rejects(connectionError('ECONNABORTED'));
      clientStub.onCall(1).rejects(connectionError('ECONNABORTED'));
      clientStub.onCall(2).resolves({ data: { result: 'deadbeef' } });

      expect(await connector.getBlockHeader('hash')).to.equal('deadbeef');
      expect(clientStub.getCall(2).args[0]).to.equal('http://10.0.0.2:8332');
    });

    it('rotates round-robin when the fallback also fails', async function () {
      connector.failoverThreshold = 1;
      clientStub.rejects(connectionError('EHOSTUNREACH'));

      await expectRejection(connector.getBlockchainInfo());
      expect(connector.url).to.equal('http://10.0.0.2:8332');
      await expectRejection(connector.getBlockchainInfo());
      expect(connector.url).to.equal('http://127.0.0.1:8332');
    });
  });

  it('does not rotate when no fallback is configured', async function () {
    connector = makeConnector(undefined, 1);
    clientStub = sinon.stub(connector.client, 'post').rejects(connectionError('ECONNREFUSED'));
    const warnStub = sinon.stub(console, 'warn');

    for (let i = 0; i < 4; i++) {
      await expectRejection(connector.getBlockchainInfo());
    }
    expect(connector.url).to.equal('http://127.0.0.1:8332');
    expect(warnStub.called).to.equal(false);
  });
});
