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
const BlockchainConnector = require('../../src/BlockchainConnector');

// Build an axios-shaped error that carries the RPC password on error.config.auth,
// exactly as axios attaches the request config to a thrown error. The leak:
// getBlockchainInfo / getBlockHash / getRawMempool rethrew this object
// unsanitized, so an upstream console.error(msg, err) serialized the password.
function axiosErrorWithAuth(code) {
  const err = new Error('connect ' + (code || 'ECONNREFUSED'));
  err.code = code || 'ECONNREFUSED';
  err.config = { auth: { username: 'rpcuser', password: 'super-secret-rpc-pass' }, headers: { Authorization: 'Basic base64creds' } };
  err.request = { _header: 'POST / HTTP/1.1\r\nAuthorization: Basic base64creds\r\n' };
  err.response = { status: 500, data: { boom: true } };
  return err;
}

describe('RPC credential scrub on the three bypassing methods', function () {
  let connector, clientStub;

  beforeEach(function () {
    connector = new BlockchainConnector('127.0.0.1', '8332', 'rpcuser', 'super-secret-rpc-pass');
    clientStub = sinon.stub(connector.client, 'post');
  });
  afterEach(function () { sinon.restore(); });

  // Each of these methods previously rethrew the raw axios error, and the tracker's
  // poll-loop / mempool-loop sinks log the full error object, leaking config.auth.
  // sanitizeRpcError scrubs in place, so after the throw config.auth must be gone.
  for (const method of ['getBlockchainInfo', 'getRawMempool']) {
    it(method + ' scrubs config.auth from the thrown error', async function () {
      const err = axiosErrorWithAuth('ECONNREFUSED');
      clientStub.rejects(err);
      let caught = null;
      try { await connector[method](); } catch (e) { caught = e; }
      expect(caught, 'should rethrow').to.be.an('error');
      expect(caught.config && caught.config.auth, 'auth must be scrubbed').to.equal(undefined);
      expect(caught.config && caught.config.headers && caught.config.headers.Authorization).to.equal(undefined);
    });
  }

  it('getBlockHash scrubs config.auth on a non-timeout error', async function () {
    const err = axiosErrorWithAuth('ECONNREFUSED');
    clientStub.rejects(err);
    let caught = null;
    try { await connector.getBlockHash(500); } catch (e) { caught = e; }
    expect(caught, 'should rethrow').to.be.an('error');
    expect(caught.config && caught.config.auth).to.equal(undefined);
  });

  it('a serialized thrown error no longer contains the password string', async function () {
    clientStub.rejects(axiosErrorWithAuth('ENOTFOUND'));
    let caught = null;
    try { await connector.getBlockchainInfo(); } catch (e) { caught = e; }
    // Simulate the upstream sink: util.inspect of the whole error object.
    const util = require('util');
    const dumped = util.inspect(caught, { depth: 4 });
    expect(dumped).to.not.include('super-secret-rpc-pass');
  });
});

describe('getBlocksBatch trusts id bijection, not positional sort', function () {
  let connector, clientStub;

  beforeEach(function () {
    connector = new BlockchainConnector('127.0.0.1', '8332', 'u', 'p');
    clientStub = sinon.stub(connector.client, 'post');
  });
  afterEach(function () { sinon.restore(); });

  it('returns hex aligned to the requested height on a well-formed response', async function () {
    clientStub.onFirstCall().resolves({ data: [ { id: 1, result: 'hash11' }, { id: 0, result: 'hash10' } ] }); // deliberately reordered
    clientStub.onSecondCall().resolves({ data: [ { id: 0, result: 'hex10' }, { id: 1, result: 'hex11' } ] });
    const out = await connector.getBlocksBatch([10, 11]);
    expect(out).to.deep.equal([
      { height: 10, hash: 'hash10', hex: 'hex10' },
      { height: 11, hash: 'hash11', hex: 'hex11' },
    ]);
  });

  it('throws on a duplicated response id (would otherwise map a block to the wrong height)', async function () {
    clientStub.onFirstCall().resolves({ data: [ { id: 0, result: 'hash10' }, { id: 1, result: 'hash11' } ] });
    clientStub.onSecondCall().resolves({ data: [ { id: 0, result: 'hexA' }, { id: 0, result: 'hexB' } ] });
    let caught = null;
    try { await connector.getBlocksBatch([10, 11]); } catch (e) { caught = e; }
    expect(caught).to.be.an('error');
    expect(caught.message).to.match(/duplicate response id/i);
  });

  it('throws on a short response instead of a bare TypeError on an undefined element', async function () {
    clientStub.onFirstCall().resolves({ data: [ { id: 0, result: 'hash10' }, { id: 1, result: 'hash11' } ] });
    clientStub.onSecondCall().resolves({ data: [ { id: 0, result: 'hexA' } ] }); // only 1 of 2
    let caught = null;
    try { await connector.getBlocksBatch([10, 11]); } catch (e) { caught = e; }
    expect(caught).to.be.an('error');
    expect(caught.message).to.match(/expected 2 results, got 1/i);
  });

  it('throws on an out-of-range response id', async function () {
    clientStub.onFirstCall().resolves({ data: [ { id: 0, result: 'hash10' }, { id: 5, result: 'hash11' } ] });
    let caught = null;
    try { await connector.getBlocksBatch([10, 11]); } catch (e) { caught = e; }
    expect(caught).to.be.an('error');
    expect(caught.message).to.match(/out of range/i);
  });
});
