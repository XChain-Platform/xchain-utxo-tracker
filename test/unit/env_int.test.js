/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 *********************************************************************/

'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const { readInt, envInt, intKnob } = require('../../src/config/env_int');
const { resolveRateLimitRpm } = require('../../src/api/startup.js');

describe('readInt', function () {
  // parseInt reads a numeric prefix, so '1.5' truncates to 1 under parseInt.
  // Number() on the trimmed whole string refuses it outright instead.
  it('does not truncate a fractional string to its integer prefix', function () {
    expect(readInt('1.5')).to.deep.equal({ absent: false, value: null });
    expect(readInt('1.5').value).to.not.equal(1);
  });
});

describe('envInt', function () {
  let errorStub;

  beforeEach(function () {
    errorStub = sinon.stub(console, 'error');
  });

  afterEach(function () {
    errorStub.restore();
  });

  it('returns the fallback when the variable is unset', function () {
    const KEY = 'X_BENCH_MISSING';
    const had = Object.prototype.hasOwnProperty.call(process.env, KEY);
    const prev = process.env[KEY];
    delete process.env[KEY];
    try {
      expect(envInt(KEY, 42, 1)).to.equal(42);
    } finally {
      if (had) process.env[KEY] = prev; else delete process.env[KEY];
    }
  });

  it('returns the fallback, not a truncated 0, when the variable is malformed', function () {
    const KEY = 'X_BENCH_BAD';
    const had = Object.prototype.hasOwnProperty.call(process.env, KEY);
    const prev = process.env[KEY];
    process.env[KEY] = '0oops';
    try {
      expect(envInt(KEY, 7, 1)).to.equal(7);
      expect(envInt(KEY, 7, 1)).to.not.equal(0);
    } finally {
      if (had) process.env[KEY] = prev; else delete process.env[KEY];
    }
  });
});

describe('intKnob', function () {
  let errorStub;

  beforeEach(function () {
    errorStub = sinon.stub(console, 'error');
  });

  afterEach(function () {
    errorStub.restore();
  });

  it('keeps the default silently when the knob is unset or blank', function () {
    expect(intKnob('X_KNOB', undefined, { fallback: 9, min: 1 })).to.equal(9);
    expect(intKnob('X_KNOB', '  ', { fallback: 9, min: 1 })).to.equal(9);
    expect(errorStub.called).to.equal(false);
  });

  it('warns once, naming the knob, and keeps the default on a typo', function () {
    expect(intKnob('X_KNOB', '30s', { fallback: 9, min: 1 })).to.equal(9);
    expect(errorStub.calledOnce).to.equal(true);
    expect(String(errorStub.firstCall.args[0])).to.include("X_KNOB='30s'");
  });
});

describe('resolveRateLimitRpm', function () {
  let errorStub;

  beforeEach(function () {
    errorStub = sinon.stub(console, 'error');
  });

  afterEach(function () {
    errorStub.restore();
  });

  it('reads the whole string, so 1e6 is a million rather than its prefix 1', function () {
    expect(resolveRateLimitRpm('1e6')).to.equal(1000000);
    expect(resolveRateLimitRpm('750')).to.equal(750);
    expect(errorStub.called).to.equal(false);
  });

  it('keeps 500 without a warning when the knob is unset', function () {
    expect(resolveRateLimitRpm(undefined)).to.equal(500);
    expect(errorStub.called).to.equal(false);
  });

  it('refuses 0 and junk with a warning, since a limit of 0 blocks every request', function () {
    for (const raw of ['0', '12garbage', '-5', '1.5']) {
      errorStub.resetHistory();
      expect(resolveRateLimitRpm(raw), raw).to.equal(500);
      expect(errorStub.calledOnce, raw).to.equal(true);
      expect(String(errorStub.firstCall.args[0])).to.include('UTXO_TRACKER_RATE_LIMIT_RPM');
    }
  });
});
