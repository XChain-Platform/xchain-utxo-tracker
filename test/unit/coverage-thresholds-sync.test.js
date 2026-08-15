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

// The coverage ratchet keeps its floors in two places: bin/coverage-thresholds.json,
// which is what a human (and ci.yml's own comment) reads, and the c8 flags inside the
// coverage:check npm script, which is what CI obeys. Nothing enforced that they agree,
// so a floor could describe a ratchet the job was not running. Here it was worse than
// drift: ci.yml named bin/coverage-thresholds.json and that file did not exist at all,
// while coverage:check gated only lines and branches, leaving statements and functions
// free to collapse without turning the job red. This test is what makes the two halves
// one fact.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('coverage ratchet floors', () => {
  const repoRoot = path.join(__dirname, '..', '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const declared = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'bin', 'coverage-thresholds.json'), 'utf8'),
  );

  it('ships the coverage:check script the CI coverage job invokes', () => {
    assert.equal(
      typeof (pkg.scripts || {})['coverage:check'],
      'string',
      'ci.yml runs `npm run coverage:check`; without the script the job can only exit 1',
    );
  });

  it('enforces every declared floor, at the declared value', () => {
    const script = pkg.scripts['coverage:check'];
    for (const metric of ['lines', 'statements', 'branches', 'functions']) {
      const flag = script.match(new RegExp('--' + metric + '\\s+([0-9.]+)'));
      assert.ok(flag, `coverage:check does not enforce --${metric}, so that floor is decorative`);
      assert.equal(
        Number(flag[1]),
        declared[metric],
        `${metric} floor drifted: thresholds.json says ${declared[metric]}, coverage:check enforces ${flag[1]}`,
      );
    }
  });

  it('fails the job on a shortfall rather than only reporting it', () => {
    assert.match(pkg.scripts['coverage:check'], /--check-coverage/);
  });
});
