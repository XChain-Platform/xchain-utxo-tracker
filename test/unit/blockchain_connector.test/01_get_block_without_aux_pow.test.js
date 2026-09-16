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
const { buildAuxPowBlockHex, buildAuxPowBlockHexEx } = require('./support/auxpow_builders');

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

function registerBasicAuxPowTests() {
  describe('getBlockWithoutAuxPow', function () {
    it('strips AuxPoW bytes when header is longer than 160 hex chars (legacy daemon path)', async function () {
      // Standard 80-byte header = 160 hex chars
      const standardHeader = 'a'.repeat(160);
      const auxPowExtra = 'bb'.repeat(50); // 100 extra hex chars
      const fullHeader = standardHeader + auxPowExtra;

      const blockBody = 'cc'.repeat(20);
      const fullBlock = standardHeader + auxPowExtra + blockBody;

      clientStub.onCall(0).resolves({ data: { result: fullHeader } }); // getBlockHeader
      clientStub.onCall(1).resolves({ data: { result: fullBlock } });  // getBlock

      const result = await connector.getBlockWithoutAuxPow('somehash');
      expect(result).to.have.length(fullBlock.length - auxPowExtra.length);
      expect(result.substring(0, 160)).to.equal(standardHeader);
    });

    it('does not strip when header is exactly 160 hex chars and no AuxPoW version bit', async function () {
      const header = 'a'.repeat(160);
      const block = 'a'.repeat(160) + 'dd'.repeat(10);

      clientStub.onCall(0).resolves({ data: { result: header } });
      clientStub.onCall(1).resolves({ data: { result: block } });

      const result = await connector.getBlockWithoutAuxPow('somehash');
      expect(result).to.equal(block);
    });

    it('strips AuxPoW by structural parse when getblockheader returns 160 chars but AuxPoW bit is set (Dogecoin Core 1.14)', async function () {
      // Dogecoin Core 1.14 always returns exactly 160 hex chars from getblockheader.
      // The stripping must be driven by parsing the AuxPoW structure from the block hex.
      const txBodyHex = 'ee'.repeat(10)  // fake tx-count + txs after AuxPoW
      const fullBlockHex = buildAuxPowBlockHex(txBodyHex)
      const pureHeader = '0'.repeat(160)  // 160 chars only, no extra AuxPoW

      clientStub.onCall(0).resolves({ data: { result: pureHeader } })   // getBlockHeader
      clientStub.onCall(1).resolves({ data: { result: fullBlockHex } }) // getBlock

      const result = await connector.getBlockWithoutAuxPow('somehash')
      // The first 160 chars are the standard header from the block hex (not from getblockheader,
      // since getBlockWithoutAuxPow preserves the block's own 80-byte header in the output)
      expect(result.substring(0, 160)).to.equal(fullBlockHex.substring(0, 160))
      // The tx body must appear immediately after the 160-char header with AuxPoW stripped
      expect(result.substring(160)).to.equal(txBodyHex)
    });
  });
}

function registerExtendedAuxPowTests() {
  describe('getBlockWithoutAuxPow', function () {
    it('strips AuxPoW with multi-hash coinbase and chain merkle branches (count > 0)', async function () {
      // Mainnet AuxPoW coinbase/chain branches routinely carry several 32-byte hashes;
      // the baseline fixture only covers count = 0. A wrong count*32+4 stride here would
      // leave branch bytes in (or eat header bytes from) the stripped output.
      const txBodyHex = 'ee'.repeat(10)
      const fullBlockHex = buildAuxPowBlockHexEx(txBodyHex, { cbBranchHashes: 3, chainBranchHashes: 2 })
      const pureHeader = '0'.repeat(160)

      clientStub.onCall(0).resolves({ data: { result: pureHeader } })
      clientStub.onCall(1).resolves({ data: { result: fullBlockHex } })

      const result = await connector.getBlockWithoutAuxPow('somehash')
      expect(result.substring(0, 160)).to.equal(fullBlockHex.substring(0, 160))
      expect(result.substring(160)).to.equal(txBodyHex)
    });

    it('strips AuxPoW with a segwit-serialized parent coinbase (marker + flag + witness)', async function () {
      // The parent chain is Litecoin, whose coinbase can carry a witness commitment.
      // This drives the hasSegwit branch (skip marker+flag, then walk the per-input
      // witness stack) that the non-segwit baseline fixture never reaches.
      const txBodyHex = 'cc'.repeat(12)
      const fullBlockHex = buildAuxPowBlockHexEx(txBodyHex, { segwit: true })
      const pureHeader = '0'.repeat(160)

      clientStub.onCall(0).resolves({ data: { result: pureHeader } })
      clientStub.onCall(1).resolves({ data: { result: fullBlockHex } })

      const result = await connector.getBlockWithoutAuxPow('somehash')
      expect(result.substring(0, 160)).to.equal(fullBlockHex.substring(0, 160))
      expect(result.substring(160)).to.equal(txBodyHex)
    });

    it('strips AuxPoW with a segwit coinbase AND multi-hash branches together', async function () {
      // The realistic mainnet shape: both branches active at once, so a sign/stride
      // error in either the witness walk or the branch arithmetic is caught.
      const txBodyHex = 'ab'.repeat(15)
      const fullBlockHex = buildAuxPowBlockHexEx(txBodyHex, { segwit: true, cbBranchHashes: 4, chainBranchHashes: 3 })
      const pureHeader = '0'.repeat(160)

      clientStub.onCall(0).resolves({ data: { result: pureHeader } })
      clientStub.onCall(1).resolves({ data: { result: fullBlockHex } })

      const result = await connector.getBlockWithoutAuxPow('somehash')
      expect(result.substring(0, 160)).to.equal(fullBlockHex.substring(0, 160))
      expect(result.substring(160)).to.equal(txBodyHex)
    });
  });
}

describe('BlockchainConnector', function () {
  registerConnectorHooks();
  registerBasicAuxPowTests();
  registerExtendedAuxPowTests();
});

