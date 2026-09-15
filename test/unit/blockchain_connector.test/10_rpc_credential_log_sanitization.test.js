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
const BlockchainConnector = require('../../../src/chain/blockchain_connector');

// Behavioral lock: the connector's axios instance bakes in auth:{username,password},
// so a failed RPC throws an error whose config.auth carries the node RPC password.
// Logging or re-throwing the raw error serializes that password into the tracker
// logs. Drive a failing getBlockHeader and assert the password never reaches
// console.error and is scrubbed from the re-thrown error. FAKE_RPC_PASSWORD is a
// test sentinel, not a real credential.
describe('BlockchainConnector RPC-credential log sanitization', function () {
  afterEach(function () { sinon.restore(); });

  it('does not leak the RPC password when an axios call fails', async function () {
    const util = require('util');
    const FAKE_RPC_PASSWORD = 'FAKEPASS_must_never_be_logged_9c3f';

    const err = new Error('Request failed with status code 401');
    err.code = 'ERR_BAD_REQUEST';
    err.config = {
      auth: { username: 'user', password: FAKE_RPC_PASSWORD },
      headers: { Authorization: 'Basic ' + Buffer.from('user:' + FAKE_RPC_PASSWORD).toString('base64') }
    };
    err.request = { _header: 'Authorization: Basic ' + Buffer.from('user:' + FAKE_RPC_PASSWORD).toString('base64') };
    err.response = { status: 401, data: 'unauthorized', config: err.config };

    const connector = new BlockchainConnector('127.0.0.1', '8332', 'user', FAKE_RPC_PASSWORD);
    sinon.stub(connector, 'sleep').resolves();
    sinon.stub(connector.client, 'post').rejects(err);

    const originalError = console.error;
    const logs = [];
    console.error = (...args) => {
      logs.push(args.map(a => (typeof a === 'string' ? a : util.inspect(a, { depth: 8 }))).join(' '));
    };

    let thrown;
    try {
      await connector.getBlockHeader('deadbeef');
    } catch (e) {
      thrown = e;
    } finally {
      console.error = originalError;
    }

    const combined = logs.join('\n');
    expect(thrown, 'the failing RPC should propagate an error').to.exist;
    expect(combined.includes(FAKE_RPC_PASSWORD),
      'the RPC password must never appear in connector error logs (got: ' + combined + ')').to.equal(false);
    expect(thrown.config && thrown.config.auth, 'the re-thrown error must have its config.auth scrubbed').to.equal(undefined);
  });
});

