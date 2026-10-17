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

// The malformed-AuxPoW recovery path (getBlockReassembled) fetches every tx with
// getrawtransaction and no blockhash, so it needs txindex=1 on the node; without
// it the tracker wedges at that height with no hint why. The boot probe names the
// misconfiguration up front, as the decoder's does, and never stops a boot.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const BlockchainConnector = require('../../src/chain/blockchain_connector');
const { warnIfTxIndexMissing, MISSING_TXINDEX_WARNING } = require('../../src/chain/txindex_check.js');
const XChainUtxoTracker = require('../../src/XChainUtxoTracker');

const TXID = 'a'.repeat(64);

function makeConnector(overrides) {
  return Object.assign(new BlockchainConnector('127.0.0.1', 0, 'user', 'pass'), overrides);
}

function recordingLog() {
  const lines = [];
  return { lines, error: (m) => lines.push(['error', m]), info: (m) => lines.push(['info', m]) };
}

describe('txindex boot probe', function () {

  describe('BlockchainConnector.probeTxIndex', function () {
    it('returns true when the tip coinbase is retrievable without a blockhash', async function () {
      const connector = makeConnector({
        getBlockchainInfo: async () => ({ blocks: 100, bestblockhash: 'tip' }),
        getBlockVerbose: async () => ({ tx: [TXID] }),
        getRawTransaction: async (txid) => { expect(txid).to.equal(TXID); return '00'; },
      });
      expect(await connector.probeTxIndex()).to.equal(true);
    });

    it('returns false when getrawtransaction finds nothing (txindex missing)', async function () {
      const connector = makeConnector({
        getBlockchainInfo: async () => ({ blocks: 100, bestblockhash: 'tip' }),
        getBlockVerbose: async () => ({ tx: [TXID] }),
        getRawTransaction: async () => null,
      });
      expect(await connector.probeTxIndex()).to.equal(false);
    });

    it('returns null on an empty chain without fetching the genesis block', async function () {
      const connector = makeConnector({
        getBlockchainInfo: async () => ({ blocks: 0, bestblockhash: 'genesis' }),
        getBlockVerbose: async () => { throw new Error('must not be called for a genesis-only chain'); },
      });
      expect(await connector.probeTxIndex()).to.equal(null);
    });

    it('returns null and never throws when a probe RPC fails', async function () {
      const connector = makeConnector({ getBlockchainInfo: async () => { throw new Error('node down'); } });
      expect(await connector.probeTxIndex()).to.equal(null);
    });
  });

});

describe('txindex boot probe', function () {

  describe('warnIfTxIndexMissing', function () {
    it('logs the warning at error level when txindex is missing', async function () {
      const log = recordingLog();
      expect(await warnIfTxIndexMissing({ probeTxIndex: async () => false }, log)).to.equal(false);
      expect(log.lines).to.deep.equal([['error', MISSING_TXINDEX_WARNING]]);
    });

    it('logs an inconclusive probe at info level', async function () {
      const log = recordingLog();
      expect(await warnIfTxIndexMissing({ probeTxIndex: async () => null }, log)).to.equal(null);
      expect(log.lines.map((l) => l[0])).to.deep.equal(['info']);
    });

    it('logs nothing when txindex works', async function () {
      const log = recordingLog();
      expect(await warnIfTxIndexMissing({ probeTxIndex: async () => true }, log)).to.equal(true);
      expect(log.lines).to.deep.equal([]);
    });

    it('skips a connector without the probe, and a probe that throws, without throwing', async function () {
      const log = recordingLog();
      expect(await warnIfTxIndexMissing({}, log)).to.equal(null);
      expect(log.lines).to.deep.equal([]);
      expect(await warnIfTxIndexMissing({ probeTxIndex: async () => { throw new Error('boom'); } }, log)).to.equal(null);
    });
  });

  describe('wiring', function () {
    it('probes only on AuxPoW chains, the only ones that can reach reassembly', function () {
      expect(new XChainUtxoTracker('dogecoin-regtest', '127.0.0.1', 1, 'u', 'p', 'txi-' + Math.random(), false).auxPow).to.equal(true);
      expect(new XChainUtxoTracker('bitcoin-regtest', '127.0.0.1', 1, 'u', 'p', 'txi-' + Math.random(), false).auxPow).to.equal(false);
      const src = fs.readFileSync(path.join(__dirname, '../../src/XChainUtxoTracker/sync_loop.js'), 'utf8');
      expect(src).to.match(/if \(this\.auxPow\) await warnIfTxIndexMissing\(this\.connector, logger\)/);
    });

    // dump.js runs as its own child before the tracker's start() on a fresh seed.
    it('probes in the bulk-sync dump for an AuxPoW chain only', async function () {
      const { probeDumpTxIndex } = require('../../src/bulk_sync/dump.js');
      let calls = 0;
      const connector = { probeTxIndex: async () => { calls++; return true; } };
      expect(await probeDumpTxIndex(connector, { chain: 'dogecoin' })).to.equal(true);
      expect(await probeDumpTxIndex(connector, { chain: 'bitcoin' })).to.equal(null);
      expect(await probeDumpTxIndex(connector, { chain: 'litecoin' })).to.equal(null);
      expect(calls).to.equal(1);
      const src = fs.readFileSync(path.join(__dirname, '../../src/bulk_sync/dump.js'), 'utf8');
      const main = src.slice(src.indexOf('async function main('));
      expect(main).to.match(/await probeDumpTxIndex\(connector, args\)/);
    });
  });
});
