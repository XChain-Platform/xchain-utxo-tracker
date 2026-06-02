'use strict';

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

  // ─── getNetworkInfo ────────────────────────────────────────────────────

  describe('getNetworkInfo', function () {
    it('returns result on success', async function () {
      clientStub.resolves({ data: { result: { version: 250000 } } });
      const info = await connector.getNetworkInfo();
      expect(info.version).to.equal(250000);
    });

    it('throws on null result', async function () {
      clientStub.resolves({ data: { result: null } });
      try {
        await connector.getNetworkInfo();
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.message).to.include('network info');
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
      // integer verbosity: 0=hex, 1=json — unlike getblockheader's boolean verbose)
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
      const timeoutErr = new Error('timeout');
      timeoutErr.code = 'ECONNABORTED';

      clientStub.onCall(0).rejects(timeoutErr);
      clientStub.onCall(1).rejects(timeoutErr);
      clientStub.onCall(2).resolves({ data: { result: 'headerdata' } });

      const result = await connector.getBlockHeader('abc');
      expect(result).to.equal('headerdata');
      expect(clientStub.callCount).to.equal(3);
    });

    it('throws after 10 timeout retries', async function () {
      const timeoutErr = new Error('timeout');
      timeoutErr.code = 'ECONNABORTED';
      clientStub.rejects(timeoutErr);

      try {
        await connector.getBlockHeader('abc');
        expect.fail('should have thrown');
      } catch (err) {
        expect(err.message).to.include('problems getting a block hex');
        expect(clientStub.callCount).to.equal(10);
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

  describe('getBlockWithoutAuxPow', function () {
    it('strips AuxPoW bytes when header is longer than 160 hex chars', async function () {
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

    it('does not strip when header is exactly 160 hex chars', async function () {
      const header = 'a'.repeat(160);
      const block = 'a'.repeat(160) + 'dd'.repeat(10);

      clientStub.onCall(0).resolves({ data: { result: header } });
      clientStub.onCall(1).resolves({ data: { result: block } });

      const result = await connector.getBlockWithoutAuxPow('somehash');
      expect(result).to.equal(block);
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
  });
});
