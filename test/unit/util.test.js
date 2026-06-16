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
const util = require('../../src/util');

describe('util', function () {

  describe('sleep', function () {
    it('resolves after the specified delay', async function () {
      const start = Date.now();
      await util.sleep(50);
      const elapsed = Date.now() - start;
      expect(elapsed).to.be.at.least(40);
    });
  });

  describe('getDataHash', function () {
    it('returns a 64-char hex SHA256 hash', function () {
      const hash = util.getDataHash({ foo: 'bar' });
      expect(hash).to.be.a('string');
      expect(hash).to.have.length(64);
      expect(hash).to.match(/^[0-9a-f]{64}$/);
    });

    it('returns same hash for identical input', function () {
      const a = util.getDataHash({ x: 1 });
      const b = util.getDataHash({ x: 1 });
      expect(a).to.equal(b);
    });

    it('returns different hash for different input', function () {
      const a = util.getDataHash({ x: 1 });
      const b = util.getDataHash({ x: 2 });
      expect(a).to.not.equal(b);
    });

    it('handles empty object', function () {
      const hash = util.getDataHash({});
      expect(hash).to.have.length(64);
    });
  });

  describe('uint8ArrayToHex', function () {
    it('converts byte array to hex string', function () {
      const arr = new Uint8Array([0xDE, 0xAD, 0xBE, 0xEF]);
      expect(util.uint8ArrayToHex(arr)).to.equal('deadbeef');
    });

    it('pads single-digit hex values with zero', function () {
      const arr = new Uint8Array([0x00, 0x01, 0x0F]);
      expect(util.uint8ArrayToHex(arr)).to.equal('00010f');
    });

    it('handles empty array', function () {
      expect(util.uint8ArrayToHex(new Uint8Array([]))).to.equal('');
    });

    it('works with a Buffer (Uint8Array subclass)', function () {
      const buf = Buffer.from([0xCA, 0xFE]);
      expect(util.uint8ArrayToHex(buf)).to.equal('cafe');
    });
  });

  describe('millisecondsToTimeString', function () {
    it('returns empty string for zero milliseconds', function () {
      // 0ms → seconds=0, so no components trigger
      expect(util.millisecondsToTimeString(0)).to.equal('');
    });

    it('formats seconds with tenths', function () {
      const result = util.millisecondsToTimeString(5500); // 5.5s
      expect(result).to.include('05.5s');
    });

    it('formats minutes and seconds', function () {
      const result = util.millisecondsToTimeString(90000); // 1m 30s
      expect(result).to.include('01m');
      expect(result).to.include('30.');
    });

    it('formats hours', function () {
      const result = util.millisecondsToTimeString(3600000); // 1h
      expect(result).to.include('01h');
    });

    it('formats days', function () {
      const result = util.millisecondsToTimeString(86400000 + 3600000); // 1d 1h
      expect(result).to.include('1d');
      expect(result).to.include('01h');
    });
  });

  describe('throwError', function () {
    it('throws an Error with the given message', function () {
      expect(() => util.throwError('boom')).to.throw('boom');
    });
  });

  describe('debug timers', function () {
    const sinon = require('sinon');
    let logStub;
    beforeEach(function () { logStub = sinon.stub(console, 'log'); });
    afterEach(function () { sinon.restore(); });

    it('startTimer returns a numeric timestamp', function () {
      const t = util.startTimer();
      expect(t).to.be.a('number');
    });

    it('logTimer logs with a custom label', function () {
      util.logTimer(util.startTimer() - 1500, 'phase');
      expect(logStub.calledOnce).to.be.true;
      expect(logStub.firstCall.args[0]).to.include('phase');
      expect(logStub.firstCall.args[0]).to.match(/ms/);
    });

    it('logTimer falls back to "Time" when no label is given', function () {
      util.logTimer(util.startTimer(), null);
      expect(logStub.firstCall.args[0]).to.include('Time');
    });

    it('markTime + addTime accumulate and logTotalTime reports then resets', function () {
      util.markTime('op');
      util.addTime('op');          // first add → initializes the **TOTAL/**COUNT entries
      util.markTime('op');
      util.addTime('op');          // second add → accumulates
      util.logTotalTime('op');     // logs and deletes the totals
      expect(logStub.called).to.be.true;
      expect(logStub.lastCall.args[0]).to.include("Time('op')");
      // After logTotalTime deletes the totals, a second call is a no-op (no extra log).
      logStub.resetHistory();
      util.logTotalTime('op');
      expect(logStub.called).to.be.false;
    });

    it('logTime logs the elapsed time for a marked name', function () {
      util.markTime('single');
      util.logTime('single');
      expect(logStub.calledOnce).to.be.true;
      expect(logStub.firstCall.args[0]).to.include("Time('single')");
    });
  });
});
