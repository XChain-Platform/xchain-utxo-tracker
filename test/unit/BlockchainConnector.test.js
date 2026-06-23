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

describe('BlockchainConnector', function () {
  let connector;
  let clientStub;

  beforeEach(function () {
    connector = new BlockchainConnector('127.0.0.1', '8332', 'user', 'pass');
    clientStub = sinon.stub(connector.client, 'post');
  });

  afterEach(function () {
    sinon.restore();
  });

  // ─── Constructor ────────────────────────────────────────────────────────

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

  // ─── getBlockchainInfo ────────────────────────────────────────────────────

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

  // ─── getBlockHash ────────────────────────────────────────────────────────

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

  // ─── getBlock ────────────────────────────────────────────────────────

  describe('getBlock', function () {
    it('returns hex when hexFormat=true (default)', async function () {
      clientStub.resolves({ data: { result: '0100000000000000...' } });
      const hex = await connector.getBlock('abc123');
      expect(hex).to.be.a('string');

      // hexFormat=true → pass verbosity 0 to getblock for hex (getblock takes an
      // integer verbosity: 0=hex, 1=json (unlike getblockheader's boolean verbose)
      const payload = clientStub.firstCall.args[1];
      expect(payload.params[1]).to.equal(0);
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

  // ─── getBlockHeader ────────────────────────────────────────────────────────

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
      const sleepStub = sinon.stub(connector, 'sleep').resolves();  // skip real backoff
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

  // ─── getBlockWithoutAuxPow ───────────────────────────────────────────────

  // Build a minimal but structurally valid AuxPoW block hex for testing the
  // structural-parse path (Dogecoin Core 1.14 behavior: getblockheader returns
  // exactly 160 hex chars regardless of merge-mining status).
  // AuxPoW layout after the 80-byte header:
  //   coinbase tx (version 4B + nIns varint + input[prevout 36B + script 0B varint + seq 4B] + nOuts varint + output[value 8B + script 0B varint] + locktime 4B)
  //   + parent block hash (32B) + coinbase branch (0 hashes, index 4B) + chain branch (0 hashes, index 4B) + parent header (80B)
  function buildAuxPowBlockHex(txBodyHex) {
    // 80-byte standard header with AuxPoW version bit (0x100) set.
    // Version bytes in little-endian: 0x00000101 -> 01 01 00 00
    const standardHeader = '01010000' + '00'.repeat(76)  // version (4 B) + 76 B padding = 80 B total = 160 hex chars

    // Minimal coinbase tx: version(4) + nIns(1=0x01) + prevout(32 zeros + ffffffff) + scriptLen(0) + seq(ffffffff) + nOuts(1) + value(0 8B) + scriptLen(0) + locktime(4)
    const coinbaseTx = (
      '01000000'        +  // version (4 B)
      '01'              +  // nIns = 1
      '00'.repeat(32) + 'ffffffff' +  // prevout hash (32 B) + index (0xffffffff)
      '00'              +  // script length = 0
      'ffffffff'        +  // sequence
      '01'              +  // nOuts = 1
      '0000000000000000' + // value = 0
      '00'              +  // script length = 0
      '00000000'           // locktime
    )
    const parentBlockHash = '00'.repeat(32)  // 32 B
    const coinbaseBranch  = '00' + '00000000'  // nHashes=0, index=0
    const chainBranch     = '00' + '00000000'  // nHashes=0, index=0
    const parentHeader    = '00'.repeat(80)   // 80 B
    const auxPow = coinbaseTx + parentBlockHash + coinbaseBranch + chainBranch + parentHeader
    return standardHeader + auxPow + txBodyHex
  }

  // Parameterized variant that exercises the two AuxPoW branches real mainnet DOGE
  // blocks hit but the 0-hash/non-segwit fixture above never does: a segwit-serialized
  // parent coinbase (marker + flag + per-input witness stack) and multi-hash coinbase/
  // chain merkle branches (count > 0). The offsets here are the mirror image of
  // skipAuxPow()'s byte-walk, so any divergence in the segwit skip or the count*32+4
  // branch arithmetic shifts the parent-header boundary and fails the round-trip below.
  function buildAuxPowBlockHexEx(txBodyHex, { segwit = false, cbBranchHashes = 0, chainBranchHashes = 0 } = {}) {
    const standardHeader = '01010000' + '00'.repeat(76)  // version w/ AuxPoW bit (0x100) + 76 B = 80 B

    let coinbaseTx = (
      '01000000'        +                 // version (4 B)
      (segwit ? '0001' : '') +            // segwit marker (00) + flag (01)
      '01'              +                 // nIns = 1
      '00'.repeat(32) + 'ffffffff' +      // prevout hash (32 B) + index
      '00'              +                 // script length = 0
      'ffffffff'        +                 // sequence
      '01'              +                 // nOuts = 1
      '0000000000000000' +                // value = 0
      '00'                                // script length = 0
    )
    if (segwit) {
      // One witness stack for the single input: 1 item of 32 bytes (coinbase
      // witness reserved value), matching skipAuxPow's per-input stack walk.
      coinbaseTx += '01' + '20' + '00'.repeat(32)
    }
    coinbaseTx += '00000000'              // locktime

    const parentBlockHash = '00'.repeat(32)
    // varint count + count*32 B hashes + 4 B index; distinct byte fills per hash so a
    // miscount is not masked by repeated bytes.
    const branch = (n) => {
      let hex = n.toString(16).padStart(2, '0')
      for (let i = 0; i < n; i++) hex += (i + 1).toString(16).padStart(2, '0').repeat(32)
      return hex + '00000000'
    }
    const parentHeader = '00'.repeat(80)
    const auxPow = coinbaseTx + parentBlockHash + branch(cbBranchHashes) + branch(chainBranchHashes) + parentHeader
    return standardHeader + auxPow + txBodyHex
  }

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

  // ─── getRawMempool ────────────────────────────────────────────────────────

  describe('getRawMempool', function () {
    it('returns array of txids', async function () {
      const txids = ['aaa', 'bbb', 'ccc'];
      clientStub.resolves({ data: { result: txids } });
      const result = await connector.getRawMempool();
      expect(result).to.deep.equal(txids);
    });

    it('throws on null result', async function () {
      clientStub.resolves({ data: { result: null } });
      try {
        await connector.getRawMempool();
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.message).to.include('mempool');
      }
    });
  });

  // ─── getRawTransaction ────────────────────────────────────────────────────

  describe('getRawTransaction', function () {
    it('returns raw hex on success', async function () {
      clientStub.resolves({ data: { result: '020000000001...' } });
      const hex = await connector.getRawTransaction('txid123');
      expect(hex).to.equal('020000000001...');
    });

    it('retries on failure up to 10 times', async function () {
      // Use a real short sleep to keep tests fast
      sinon.stub(connector, 'sleep').resolves();

      clientStub.rejects(new Error('timeout'));

      try {
        await connector.getRawTransaction('txid123');
        expect.fail('should have rejected');
      } catch (err) {
        // After 10 tries it rejects with an Error carrying the txid for context
        expect(clientStub.callCount).to.equal(10);
        expect(err).to.be.an.instanceof(Error);
        expect(err.message).to.contain('txid123');
      }
    });

    it('succeeds after transient failures', async function () {
      sinon.stub(connector, 'sleep').resolves();
      clientStub.onCall(0).rejects(new Error('timeout'));
      clientStub.onCall(1).rejects(new Error('timeout'));
      clientStub.onCall(2).resolves({ data: { result: 'hexdata' } });

      const result = await connector.getRawTransaction('txid');
      expect(result).to.equal('hexdata');
      expect(clientStub.callCount).to.equal(3);
    });
  });

  // ─── getRawTransactions ───────────────────────────────────────────────────

  describe('getRawTransactions', function () {
    it('fetches all txids in parallel', async function () {
      clientStub.resolves({ data: { result: 'hexdata' } });
      const results = await connector.getRawTransactions(['tx1', 'tx2', 'tx3']);
      expect(results).to.have.length(3);
      expect(results.every(r => r === 'hexdata')).to.be.true;
    });

    it('returns empty array for empty input', async function () {
      const results = await connector.getRawTransactions([]);
      expect(results).to.be.empty;
    });
  });

  // ─── getBlocksBatch ─────────────────────────────────────────────────────

  describe('getBlocksBatch', function () {
    it('returns empty array for empty heights', async function () {
      const result = await connector.getBlocksBatch([]);
      expect(result).to.deep.equal([]);
      expect(clientStub.called).to.be.false;
    });

    it('issues exactly 2 HTTP calls for N heights', async function () {
      const heights = [100, 101, 102];
      const hashes = ['hash100', 'hash101', 'hash102'];

      // First call: batch getblockhash
      clientStub.onCall(0).resolves({
        data: heights.map((h, i) => ({ id: i, result: hashes[i] }))
      });

      // Second call: batch getblock
      clientStub.onCall(1).resolves({
        data: hashes.map((hash, i) => ({ id: i, result: 'hex' + i }))
      });

      const results = await connector.getBlocksBatch(heights);
      expect(clientStub.callCount).to.equal(2);
      expect(results).to.have.length(3);
      expect(results[0]).to.deep.equal({ height: 100, hash: 'hash100', hex: 'hex0' });
      expect(results[2]).to.deep.equal({ height: 102, hash: 'hash102', hex: 'hex2' });
    });

    it('handles out-of-order batch responses', async function () {
      clientStub.onCall(0).resolves({
        data: [
          { id: 1, result: 'hash_b' },
          { id: 0, result: 'hash_a' }
        ]
      });
      clientStub.onCall(1).resolves({
        data: [
          { id: 1, result: 'hex_b' },
          { id: 0, result: 'hex_a' }
        ]
      });

      const results = await connector.getBlocksBatch([10, 11]);
      expect(results[0].hash).to.equal('hash_a');
      expect(results[1].hash).to.equal('hash_b');
    });

    it('throws when a hash in batch is null', async function () {
      clientStub.onCall(0).resolves({
        data: [{ id: 0, result: null }]
      });

      try {
        await connector.getBlocksBatch([100]);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.message).to.include('batch');
      }
    });

    it('throws when a block result in batch is null', async function () {
      // Hash batch succeeds, block batch returns a null result for one entry.
      clientStub.onCall(0).resolves({ data: [{ id: 0, result: 'hash0' }] });
      clientStub.onCall(1).resolves({ data: [{ id: 0, result: null }] });

      try {
        await connector.getBlocksBatch([100]);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.message).to.include('block in batch');
      }
    });
  });

  // ─── additional branch coverage ───────────────────────────────────────────

  describe('getRawTransaction (tx no longer present)', function () {
    it('resolves null when the node returns no result (mined/evicted)', async function () {
      clientStub.resolves({ data: { result: null } });
      const result = await connector.getRawTransaction('gone-txid');
      expect(result).to.equal(null);
    });
  });

  describe('getBlock (error branch)', function () {
    it('throws and rethrows when the node returns no result', async function () {
      clientStub.resolves({ data: {} }); // postWithRetry returns it; no .result
      try {
        await connector.getBlock('hashX');
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.message).to.include('block hex');
      }
    });
  });

  describe('postWithRetry', function () {
    it('retries on ECONNABORTED then succeeds', async function () {
      sinon.stub(connector, 'sleep').resolves();
      clientStub.onCall(0).rejects({ code: 'ECONNABORTED' });
      clientStub.onCall(1).resolves({ data: { result: 'ok' } });
      const res = await connector.postWithRetry({ method: 'x' });
      expect(res.data.result).to.equal('ok');
      expect(clientStub.callCount).to.equal(2);
    });

    it('rethrows a non-timeout error immediately', async function () {
      clientStub.rejects(new Error('connection refused'));
      try {
        await connector.postWithRetry({ method: 'x' });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.message).to.include('connection refused');
        expect(clientStub.callCount).to.equal(1);
      }
    });

    it('throws after exhausting the 10 timeout retries', async function () {
      sinon.stub(connector, 'sleep').resolves();
      clientStub.rejects({ code: 'ECONNABORTED' });
      try {
        await connector.postWithRetry({ method: 'x' });
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.message).to.include('after retries');
        expect(clientStub.callCount).to.equal(10);
      }
    });
  });

  describe('getBlocksBatchWithoutAuxPow', function () {
    it('returns empty array for empty heights', async function () {
      const result = await connector.getBlocksBatchWithoutAuxPow([]);
      expect(result).to.deep.equal([]);
      expect(clientStub.called).to.be.false;
    });

    it('fetches hash+header+block batches and strips AuxPoW bytes', async function () {
      const heights = [200, 201];
      // call 0: getblockhash batch
      clientStub.onCall(0).resolves({ data: heights.map((h, i) => ({ id: i, result: 'hash' + i })) });
      // call 1: getblockheader batch: index 0 header longer than 160 hex chars (AuxPoW), index 1 exactly 160
      clientStub.onCall(1).resolves({ data: [
        { id: 0, result: 'a'.repeat(200) },  // 40 extra hex chars of AuxPoW
        { id: 1, result: 'b'.repeat(160) }   // standard header, nothing to strip
      ]});
      // call 2: getblock batch
      clientStub.onCall(2).resolves({ data: [
        { id: 0, result: 'h'.repeat(160) + 'x'.repeat(40) + 'TX0' },
        { id: 1, result: 'h'.repeat(160) + 'TX1' }
      ]});

      const results = await connector.getBlocksBatchWithoutAuxPow(heights);
      expect(clientStub.callCount).to.equal(3);
      expect(results).to.have.length(2);
      // index 0: 40 auxpow hex chars removed → header(160) + 'TX0'
      expect(results[0]).to.deep.equal({ height: 200, hash: 'hash0', hex: 'h'.repeat(160) + 'TX0' });
      // index 1: nothing stripped
      expect(results[1]).to.deep.equal({ height: 201, hash: 'hash1', hex: 'h'.repeat(160) + 'TX1' });
    });

    it('throws when a hash batch entry is null', async function () {
      clientStub.onCall(0).resolves({ data: [{ id: 0, result: null }] });
      try {
        await connector.getBlocksBatchWithoutAuxPow([5]);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.message).to.include('block hash in batch');
      }
    });

    it('throws when a header batch entry is null', async function () {
      clientStub.onCall(0).resolves({ data: [{ id: 0, result: 'hash0' }] });
      clientStub.onCall(1).resolves({ data: [{ id: 0, result: null }] });
      try {
        await connector.getBlocksBatchWithoutAuxPow([5]);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.message).to.include('block header in batch');
      }
    });

    it('throws when a block batch entry is null', async function () {
      clientStub.onCall(0).resolves({ data: [{ id: 0, result: 'hash0' }] });
      clientStub.onCall(1).resolves({ data: [{ id: 0, result: 'h'.repeat(160) }] });
      clientStub.onCall(2).resolves({ data: [{ id: 0, result: null }] });
      try {
        await connector.getBlocksBatchWithoutAuxPow([5]);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.message).to.include('block in batch');
      }
    });

    it('strips AuxPoW by structural parse when getblockheader returns 160 chars but AuxPoW bit is set (Dogecoin Core 1.14)', async function () {
      // Mirrors the single-block test: header always 160 chars, strip from block hex.
      const txBodyHex = 'ff'.repeat(8)
      const fullBlockHex = buildAuxPowBlockHex(txBodyHex)
      const pureHeader = '0'.repeat(160)

      clientStub.onCall(0).resolves({ data: [{ id: 0, result: 'hash0' }] })
      clientStub.onCall(1).resolves({ data: [{ id: 0, result: pureHeader }] })
      clientStub.onCall(2).resolves({ data: [{ id: 0, result: fullBlockHex }] })

      const results = await connector.getBlocksBatchWithoutAuxPow([42])
      expect(results).to.have.length(1)
      expect(results[0].height).to.equal(42)
      expect(results[0].hex.substring(0, 160)).to.equal(fullBlockHex.substring(0, 160))
      expect(results[0].hex.substring(160)).to.equal(txBodyHex)
    });
  });
});
