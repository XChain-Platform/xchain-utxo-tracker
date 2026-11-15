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

// A readiness withdrawal that writes the flag directly skips the generation a
// pass compares (mempool_readiness.js), so a pass in flight could still assert
// readiness over it. Only the constructor's initial value and the pass's own
// reset before it stages (mempool_refresh.js) may write the flag directly.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const FLAG_FALSE_WRITE = /\.mempoolReconverged\s*=\s*false\b/;
const ALLOWED = new Map([
  ['XChainUtxoTracker.js', 1],
  ['XChainUtxoTracker/mempool_readiness.js', 1],
  ['XChainUtxoTracker/mempool_refresh.js', 1]
]);

function sourceFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

function directFalseWrites(text) {
  return text.split('\n').filter(line => FLAG_FALSE_WRITE.test(line)).length;
}

function writersByFile() {
  const found = new Map();
  for (const file of sourceFiles(SRC)) {
    const count = directFalseWrites(fs.readFileSync(file, 'utf8'));
    if (count > 0) found.set(path.relative(SRC, file), count);
  }
  return found;
}

describe('Regression: mempool readiness is withdrawn through one helper', function () {
  it('writes the flag false directly only in the constructor, the helper and the pass reset', function () {
    const found = writersByFile();
    expect(found.size, 'the scan found no writers, so it checked nothing').to.be.greaterThan(0);
    expect(Object.fromEntries(found)).to.deep.equal(Object.fromEntries(ALLOWED));
  });

  it('flags a direct write added to another file', function () {
    expect(directFalseWrites('this.synced = false\nthis.mempoolReconverged = false\n')).to.equal(1);
    expect(directFalseWrites('revokeMempoolReadiness.call(this)\n')).to.equal(0);
  });
});
