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
const XChainBlockDecoder = require('../../src/XChainBlockDecoder');
const bitcoinjs = require('bitcoinjs-lib');

describe('XChainBlockDecoder', function () {

  describe('constructor', function () {
    it('extracts coin name from network string', function () {
      const decoder = new XChainBlockDecoder('bitcoin-mainnet');
      expect(decoder.coin).to.equal('bitcoin');
    });

    it('extracts coin name for dogecoin', function () {
      const decoder = new XChainBlockDecoder('dogecoin-testnet');
      expect(decoder.coin).to.equal('dogecoin');
    });

    it('extracts coin name for litecoin', function () {
      const decoder = new XChainBlockDecoder('litecoin-regtest');
      expect(decoder.coin).to.equal('litecoin');
    });
  });

  describe('doubleSha256AndReverse', function () {
    it('returns a 32-byte reversed double-SHA256', function () {
      const decoder = new XChainBlockDecoder('bitcoin-mainnet');
      const data = Buffer.from('test data');
      const result = decoder.doubleSha256AndReverse(data);
      expect(result).to.be.instanceOf(Buffer);
      expect(result.length).to.equal(32);
    });

    it('is deterministic', function () {
      const decoder = new XChainBlockDecoder('bitcoin-mainnet');
      const data = Buffer.from('hello');
      const a = decoder.doubleSha256AndReverse(data);
      const b = decoder.doubleSha256AndReverse(data);
      expect(a).to.deep.equal(b);
    });
  });

  describe('blockFromHex (bitcoin)', function () {
    const decoder = new XChainBlockDecoder('bitcoin-mainnet');

    it('parses a header-only block (80 bytes)', function () {
      // Build a minimal 80-byte block header
      const header = Buffer.alloc(80);
      header.writeInt32LE(1, 0);       // version
      header.writeUInt32LE(1234, 68);  // timestamp
      header.writeUInt32LE(0x1d00ffff, 72); // bits
      header.writeUInt32LE(42, 76);    // nonce

      const block = decoder.blockFromHex(header.toString('hex'));
      expect(block.version).to.equal(1);
      expect(block.timestamp).to.equal(1234);
      expect(block.nonce).to.equal(42);
      expect(block.transactions).to.be.undefined; // header-only
    });

    it('throws for buffer smaller than 80 bytes', function () {
      expect(() => decoder.blockFromHex('aabb')).to.throw();
    });

    it('parses a header-only block with correct fields', function () {
      // Build a header with specific known values
      const header = Buffer.alloc(80);
      header.writeInt32LE(0x20000000, 0); // version
      // prevHash: 32 bytes of 0xAA
      Buffer.alloc(32, 0xAA).copy(header, 4);
      // merkleRoot: 32 bytes of 0xBB
      Buffer.alloc(32, 0xBB).copy(header, 36);
      header.writeUInt32LE(1700000000, 68); // timestamp
      header.writeUInt32LE(0x1d00ffff, 72); // bits
      header.writeUInt32LE(12345, 76);      // nonce

      const block = decoder.blockFromHex(header.toString('hex'));
      expect(block.version).to.equal(0x20000000);
      expect(block.timestamp).to.equal(1700000000);
      expect(block.nonce).to.equal(12345);
      expect(block.prevHash).to.have.length(32);
      expect(block.merkleRoot).to.have.length(32);
    });
  });

  describe('blockFromHex (litecoin)', function () {
    const decoder = new XChainBlockDecoder('litecoin-mainnet');

    it('parses a header-only block', function () {
      const header = Buffer.alloc(80);
      header.writeInt32LE(2, 0);
      header.writeUInt32LE(9999, 68);

      const block = decoder.blockFromHex(header.toString('hex'));
      expect(block.version).to.equal(2);
      expect(block.timestamp).to.equal(9999);
    });

    it('throws for truncated buffer', function () {
      expect(() => decoder.blockFromHex('00'.repeat(40))).to.throw();
    });
  });

  describe('txFromHex (bitcoin)', function () {
    const decoder = new XChainBlockDecoder('bitcoin-mainnet');

    it('parses a minimal coinbase transaction', function () {
      // Minimal valid non-witness tx: version=1, 1 coinbase input, 1 OP_TRUE output
      const txHex =
        '01000000' +                         // version
        '01' +                               // input count
        '0000000000000000000000000000000000000000000000000000000000000000' + // prev tx (null for coinbase)
        'ffffffff' +                         // prev output index (coinbase marker)
        '04' +                               // script length (4 bytes)
        'deadbeef' +                         // coinbase script data
        'ffffffff' +                         // sequence
        '01' +                               // output count
        '0100000000000000' +                 // value: 1 satoshi (LE)
        '01' +                               // scriptPubKey length
        '51' +                               // OP_1 (OP_TRUE)
        '00000000';                          // locktime

      const tx = decoder.txFromHex(txHex);
      expect(tx.ins).to.have.length(1);
      expect(tx.outs).to.have.length(1);
      expect(Number(tx.outs[0].value)).to.equal(1);
    });
  });

  describe('txFromHex (litecoin) - HogEx stripping', function () {
    const decoder = new XChainBlockDecoder('litecoin-mainnet');

    it('strips HogEx flag (0x00 0x08) from v1 tx', function () {
      // version(01000000) + marker(00) + flag(08); after stripping marker+flag
      // the remainder must parse as a valid non-witness tx.
      const baseTxHex =
        '01000000' +
        '01' +
        '0000000000000000000000000000000000000000000000000000000000000000' +
        'ffffffff' +
        '04' + '01020304' +
        'ffffffff' +
        '01' +
        '0100000000000000' +
        '01' + '51' + // OP_1
        '00000000';

      // Insert marker+flag after version
      const hogexTxHex = '01000000' + '0008' + baseTxHex.substring(8);

      const tx = decoder.txFromHex(hogexTxHex);
      expect(tx.ins).to.have.length(1);
      expect(tx.outs).to.have.length(1);
    });

    it('passes through non-HogEx tx unchanged', function () {
      const normalTxHex =
        '02000000' +
        '01' +
        '0000000000000000000000000000000000000000000000000000000000000000' +
        'ffffffff' +
        '04' + '01020304' +
        'ffffffff' +
        '01' +
        '0100000000000000' +
        '01' + '51' +
        '00000000';

      const tx = decoder.txFromHex(normalTxHex);
      expect(tx.ins).to.have.length(1);
      expect(tx.outs).to.have.length(1);
    });

    it('does not strip when the tx version is neither 01 nor 02', function () {
      // version=03 → the HogEx-strip guard is false; the tx is parsed verbatim.
      const v3Tx =
        '03000000' +
        '01' +
        '0000000000000000000000000000000000000000000000000000000000000000' +
        'ffffffff' +
        '04' + '01020304' +
        'ffffffff' +
        '01' +
        '0100000000000000' +
        '01' + '51' +
        '00000000';
      const tx = decoder.txFromHex(v3Tx);
      expect(tx.version).to.equal(3);
      expect(tx.ins).to.have.length(1);
    });

    it('strips the MWEB+segwit flag (0x00 0x09) from a v2 tx', function () {
      const baseTxHex =
        '02000000' +
        '01' +
        '0000000000000000000000000000000000000000000000000000000000000000' +
        'ffffffff' +
        '04' + '01020304' +
        'ffffffff' +
        '01' +
        '0100000000000000' +
        '01' + '51' +
        '00000000';
      // version(02000000) + marker(00) + flag(09) + rest-after-version
      const mwebTxHex = '02000000' + '0009' + baseTxHex.substring(8);
      const tx = decoder.txFromHex(mwebTxHex);
      expect(tx.ins).to.have.length(1);
      expect(tx.outs).to.have.length(1);
    });
  });

  describe('blockFromBuffer (litecoin) - full block with transactions', function () {
    const decoder = new XChainBlockDecoder('litecoin-mainnet');

    // Coinbase tx body after the 8-char version field (shared by both cases).
    const txAfterVersion =
      '01' +                                                              // input count
      '0000000000000000000000000000000000000000000000000000000000000000' + // coinbase prev (null)
      'ffffffff' +                                                        // coinbase index
      '04' + '01020304' +                                                 // script
      'ffffffff' +                                                        // sequence
      '01' +                                                              // output count
      '0100000000000000' +                                                // value 1 sat
      '01' + '51' +                                                       // OP_1
      '00000000';                                                         // locktime

    function header(){
      const h = Buffer.alloc(80);
      h.writeInt32LE(1, 0);        // version
      h.writeUInt32LE(12345, 68);  // timestamp
      return h.toString('hex');
    }

    it('parses a litecoin block whose single (normal) tx is not HogEx', function () {
      const normalTx = '01000000' + txAfterVersion; // marker byte = 0x01 (input count) → not HogEx
      const blockHex = header() + '01' + normalTx;
      const block = decoder.blockFromHex(blockHex);
      expect(block.transactions).to.have.length(1);
      expect(block.transactions[0].ins).to.have.length(1);
    });

    it('strips the HogEx marker+flag from the last tx of a litecoin block', function () {
      // Last (only) tx carries marker 0x00 + flag 0x08 right after the version.
      const hogexTx = '01000000' + '0008' + txAfterVersion;
      const blockHex = header() + '01' + hogexTx;
      const block = decoder.blockFromHex(blockHex);
      expect(block.transactions).to.have.length(1);
      expect(block.transactions[0].outs).to.have.length(1);
    });
  });
});
