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
const fs = require('fs');
const path = require('path');

// Regression: the first-seen freshness gap and the frozen legacy shape.
//
// get_utxos / get_balance / get_info all attach the additive `sync` meta, and the
// REST twin GET /firstseen/:address stamps the same facts as headers, but the
// JSON-RPC get_first_seen returned a bare {height}/null: a null from a lagging,
// halted or unwinding tracker was indistinguishable from an address that has
// genuinely never appeared. get_first_seen_status closes that gap in one
// unambiguous shape while get_first_seen stays byte-identical, because
// xchain-indexer's UtxoTracker client parses it positionally into a
// replay-frozen dispenser verdict.
//
// The controller lives inside startApi()'s closure and is not reachable from a
// require, so these are source guards, the same shape as the getFreshnessMeta
// wiring guard in query-freshness-and-bootstrap-recovery.test.js.
describe('get_first_seen_status (freshness-aware sibling)', function () {

  const src = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');

  function methodBody(name) {
    const start = src.indexOf('async ' + name + '({');
    expect(start, name + ' must be registered on the JSON-RPC controller').to.be.greaterThan(-1);
    const rest = src.slice(start);
    return rest.slice(0, rest.indexOf('\n        },'));
  }

  it('registers the sibling and returns first_seen plus the sync meta', function () {
    const body = methodBody('get_first_seen_status');
    expect(body).to.match(/getFirstSeen\(address\)/);
    expect(body).to.match(/first_seen:/);
    expect(body).to.match(/sync:\s*await getFreshnessMeta\(\)/);
  });

  it('normalises a never-seen address to an explicit null rather than undefined', function () {
    // tracker.getFirstSeen returns null or {height}; the wrapper must never emit
    // an absent key, or the caller is back to guessing.
    expect(methodBody('get_first_seen_status')).to.match(/first_seen:\s*firstSeen\s*\|\|\s*null/);
  });

  it('leaves the legacy get_first_seen shape frozen', function () {
    const body = methodBody('get_first_seen');
    expect(body).to.match(/return await getFirstSeen\(address\)/);
    expect(body).to.not.match(/getFreshnessMeta/);
    expect(body).to.not.match(/first_seen:/);
  });
});
