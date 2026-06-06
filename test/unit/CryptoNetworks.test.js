'use strict';

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

const { expect } = require('chai');
const CryptoNetworks = require('../../src/CryptoNetworks');

describe('CryptoNetworks', function () {

  describe('getBitcoinJsNetwork', function () {

    it('returns Bitcoin mainnet params', function () {
      const net = CryptoNetworks.getBitcoinJsNetwork('bitcoin-mainnet');
      expect(net).to.exist;
      expect(net.bech32).to.equal('bc');
      expect(net.pubKeyHash).to.equal(0x00);
      expect(net.scriptHash).to.equal(0x05);
    });

    it('returns Bitcoin testnet params', function () {
      const net = CryptoNetworks.getBitcoinJsNetwork('bitcoin-testnet');
      expect(net).to.exist;
      expect(net.bech32).to.equal('tb');
      expect(net.pubKeyHash).to.equal(0x6f);
    });

    it('returns Bitcoin regtest params', function () {
      const net = CryptoNetworks.getBitcoinJsNetwork('bitcoin-regtest');
      expect(net).to.exist;
      expect(net.bech32).to.equal('bcrt');
    });

    it('returns Dogecoin mainnet params', function () {
      const net = CryptoNetworks.getBitcoinJsNetwork('dogecoin-mainnet');
      expect(net).to.exist;
      expect(net.pubKeyHash).to.equal(0x1e);
      expect(net.scriptHash).to.equal(0x16);
      expect(net.messagePrefix).to.include('Dogecoin');
    });

    it('returns Dogecoin testnet params', function () {
      const net = CryptoNetworks.getBitcoinJsNetwork('dogecoin-testnet');
      expect(net).to.exist;
      expect(net.pubKeyHash).to.equal(0x71);
    });

    it('returns Dogecoin regtest params', function () {
      const net = CryptoNetworks.getBitcoinJsNetwork('dogecoin-regtest');
      expect(net).to.exist;
      // Dogecoin v1.14.x regtest reuses Bitcoin-testnet prefixes (0x6f / 0xef),
      // NOT Dogecoin-testnet prefixes (0x71 / 0xf1). See src/CryptoNetworks.js.
      expect(net.pubKeyHash).to.equal(0x6f);
      expect(net.wif).to.equal(0xef);
    });

    it('returns Litecoin mainnet params', function () {
      const net = CryptoNetworks.getBitcoinJsNetwork('litecoin-mainnet');
      expect(net).to.exist;
      expect(net.bech32).to.equal('ltc');
      expect(net.pubKeyHash).to.equal(0x30);
      expect(net.scriptHash).to.equal(0x32);
    });

    it('returns Litecoin testnet params', function () {
      const net = CryptoNetworks.getBitcoinJsNetwork('litecoin-testnet');
      expect(net).to.exist;
      expect(net.bech32).to.equal('tltc');
      expect(net.pubKeyHash).to.equal(0x6f);
    });

    it('returns Litecoin regtest params', function () {
      const net = CryptoNetworks.getBitcoinJsNetwork('litecoin-regtest');
      expect(net).to.exist;
      expect(net.bech32).to.equal('rltc');
    });

    it('returns undefined for unknown network', function () {
      const net = CryptoNetworks.getBitcoinJsNetwork('ethereum-mainnet');
      expect(net).to.be.undefined;
    });

    it('returns undefined for empty string', function () {
      const net = CryptoNetworks.getBitcoinJsNetwork('');
      expect(net).to.be.undefined;
    });

    it('all networks have required fields', function () {
      const networks = [
        'bitcoin-mainnet', 'bitcoin-testnet', 'bitcoin-regtest',
        'dogecoin-mainnet', 'dogecoin-testnet', 'dogecoin-regtest',
        'litecoin-mainnet', 'litecoin-testnet', 'litecoin-regtest'
      ];

      for (const name of networks) {
        const net = CryptoNetworks.getBitcoinJsNetwork(name);
        expect(net, name).to.have.property('pubKeyHash');
        expect(net, name).to.have.property('wif');
        expect(net, name).to.have.nested.property('bip32.public');
        expect(net, name).to.have.nested.property('bip32.private');
      }
    });
  });
});
