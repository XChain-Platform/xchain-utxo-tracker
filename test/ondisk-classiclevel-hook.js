'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available —
// contact legal@dankest.llc.

// Mocha root-hook + module patch that forces LevelUpStore.createDatabase to use
// an on-disk classic-level database (in a fresh temp dir per call) instead of
// the in-memory memory-level used by the default unit/integration runs.
//
// Purpose: exercise the SAME unit/integration assertions through the real
// on-disk LevelDB engine (classic-level), not just its in-memory sibling.
// Each createDatabase() call gets its own temp dir, matching the fresh-store
// semantics the suites assume; all dirs are removed after the run.
//
// Usage: mocha --require ./test/ondisk-classiclevel-hook.js <specs>
// (see the test:unit:ondisk / test:integration:ondisk npm scripts)

const fs = require('fs')
const os = require('os')
const path = require('path')
const { ClassicLevel } = require('classic-level')
const LevelUpStore = require('./../src/LevelUpDb')

const tmpDirs = []

LevelUpStore.prototype.createDatabase = async function () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-ondisk-'))
  tmpDirs.push(dir)
  // Always on-disk classic-level, regardless of the inMemory constructor flag,
  // so the full assertion set runs against the real storage engine.
  this.db = new ClassicLevel(dir, { keyEncoding: 'buffer', valueEncoding: 'buffer' })
  await this.db.open()
  return this.db
}

exports.mochaHooks = {
  afterAll() {
    for (const d of tmpDirs) {
      try { fs.rmSync(d, { recursive: true, force: true }) } catch (e) { /* ignore */ }
    }
  },
}
