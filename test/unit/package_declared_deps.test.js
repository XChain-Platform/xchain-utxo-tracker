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

const assert = require('node:assert/strict');
const lock = require('../../package-lock.json');
const manifest = require('../../package.json');

const REQUIRED_DEPENDENCIES = {
  'body-parser': '^2.2.1',
  'varuint-bitcoin': '^1.1.2',
};

describe('package declared dependencies', () => {
  for (const [name, range] of Object.entries(REQUIRED_DEPENDENCIES)) {
    it(`declares ${name} directly in the manifest and lockfile`, () => {
      assert.equal(manifest.dependencies[name], range);
      assert.equal(lock.packages[''].dependencies[name], range);
      assert.ok(lock.packages[`node_modules/${name}`]);
    });
  }
});
