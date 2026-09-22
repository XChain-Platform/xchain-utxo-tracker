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
const { readInt, envInt } = require('../../src/config/env_int');

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
