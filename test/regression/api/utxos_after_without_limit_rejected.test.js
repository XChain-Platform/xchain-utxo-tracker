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

// A cursor (?after=) only means something on a paged read, so a cursor sent
// without ?limit= is rejected with HTTP 400 rather than dropped, which would
// return the full unpaged row set.

const { expect } = require('chai');
const { parsePageOpts } = require('../../../src/api/startup');

const MAX = 1000;

function catchErr(fn) {
  try { fn(); } catch (e) { return e; }
  return null;
}

describe('parsePageOpts: after without limit', function () {
  it('rejects a garbage cursor sent without a limit', function () {
    const e = catchErr(() => parsePageOpts({ after: 'garbage' }, MAX));
    expect(e).to.be.an('error');
    expect(e.code).to.equal('BAD_REQUEST');
  });

  it('rejects a well-formed cursor sent without a limit', function () {
    const e = catchErr(() => parsePageOpts({ after: 'a1b2c3d4:0' }, MAX));
    expect(e).to.be.an('error');
    expect(e.code).to.equal('BAD_REQUEST');
  });

  it('rejects a cursor with an empty limit', function () {
    const e = catchErr(() => parsePageOpts({ limit: '', after: 'x' }, MAX));
    expect(e && e.code).to.equal('BAD_REQUEST');
  });

  it('still passes a cursor through when a limit is present', function () {
    expect(parsePageOpts({ limit: '5', after: 'x' }, MAX)).to.deep.equal({ limit: 5, after: 'x' });
  });

  it('keeps unpaged and empty-cursor reads allowed', function () {
    expect(parsePageOpts({}, MAX)).to.deep.equal({});
    expect(parsePageOpts({ after: '' }, MAX)).to.deep.equal({});
    expect(parsePageOpts(undefined, MAX)).to.deep.equal({});
    expect(parsePageOpts({ limit: '3' }, MAX)).to.deep.equal({ limit: 3 });
  });
});
