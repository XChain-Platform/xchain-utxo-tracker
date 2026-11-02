'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// "params": null is a caller mistake like absent params. It must not reach a
// handler's argument destructure and leave as -32603 with a raw TypeError text.

const { expect } = require('chai');
const sinon = require('sinon');
const { createJsonRpcController } = require('../../../src/api/routes');

function makeContext() {
  const badRequest = () => Object.assign(new Error('address is required'), { code: 'BAD_REQUEST' });
  return {
    getUtxos: sinon.stub().callsFake(async (a) => { if (typeof a !== 'string') throw badRequest(); return []; }),
    getBalance: sinon.stub().callsFake(async (a) => { if (typeof a !== 'string') throw badRequest(); return { balance: '0' }; }),
    getFirstSeen: sinon.stub().callsFake(async (a) => { if (typeof a !== 'string') throw badRequest(); return null; }),
    getFirstSeenAt: sinon.stub().callsFake(async (a) => { if (typeof a !== 'string') throw badRequest(); return { firstSeen: null }; }),
    getInfo: sinon.stub().callsFake(async (a) => { if (typeof a !== 'string') throw badRequest(); return {}; }),
    parsePageOpts: (o) => o,
    getFreshnessMeta: sinon.stub().resolves({}),
    tracker: { db: { getTxBlock: sinon.stub().resolves(null) } }
  };
}

describe('JSON-RPC readers with params null', function () {
  const methods = ['get_utxos', 'get_balance', 'get_first_seen', 'get_first_seen_status', 'get_info', 'get_tx_block'];

  for (const method of methods) {
    it(`${method} never answers an internal error for null params`, async function () {
      const ctx = makeContext();
      const controller = createJsonRpcController(ctx);
      let thrown = null;
      let result;
      try { result = await controller[method](null); } catch (e) { thrown = e; }
      if (thrown) {
        expect(thrown).to.not.be.instanceOf(TypeError);
        expect(thrown.code).to.equal(-32602);
      } else {
        expect(result).to.have.property('error');
      }
    });
  }

  it('still serves valid params', async function () {
    const ctx = makeContext();
    const controller = createJsonRpcController(ctx);
    const r = await controller.get_utxos({ address: 'addr1' });
    expect(r.utxos).to.deep.equal([]);
    expect(ctx.getUtxos.calledOnce).to.equal(true);
  });
});
