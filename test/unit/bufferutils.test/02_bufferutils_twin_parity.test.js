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

// src/chain/apply_bufferutils_patch.js and src/chain/bufferutils.js are byte-identical
// twins of the xchain-decoder files at the same paths. Both services decode the same
// blocks, so a one-sided edit (the verifuint bounds, the unsigned 64-bit read, the
// writer's Number/BigInt acceptance) splits UTXO-set and action-record output values at
// the same height. Change both copies together; the decoder carries the mirror guard.
//
// Skips when the sibling xchain-decoder checkout is absent (standalone deploy); set
// XCHAIN_REQUIRE_SIBLINGS=1 in CI (with the sibling checked out, or XCHAIN_DECODER_DIR
// pointed at it) so a missing sibling hard-fails instead of green-by-skip.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '../../..');
const DECODER_DIR = process.env.XCHAIN_DECODER_DIR ||
    path.join(__dirname, '../../../../xchain-decoder');
const TWIN_FILES = ['src/chain/apply_bufferutils_patch.js', 'src/chain/bufferutils.js'];
const REQUIRE_SIBLINGS = process.env.XCHAIN_REQUIRE_SIBLINGS === '1';

// Names the first differing line so a drift report points at the edit.
function firstDifferingLine(a, b) {
    const la = a.toString('utf8').split('\n');
    const lb = b.toString('utf8').split('\n');
    for (let i = 0; i < Math.max(la.length, lb.length); i++) {
        if (la[i] !== lb[i]) return 'line ' + (i + 1) + ':\n  tracker: ' + la[i] + '\n  decoder: ' + lb[i];
    }
    return 'no line differs (whitespace or trailing bytes)';
}

describe('bufferutils patch twin parity with xchain-decoder @regression', function () {
    before(function () {
        const twin = path.join(DECODER_DIR, TWIN_FILES[0]);
        if (fs.existsSync(twin)) return;
        if (REQUIRE_SIBLINGS)
            throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but the xchain-decoder twin was not found at ' + twin);
        this.skip();
    });

    for (const rel of TWIN_FILES) {
        it(rel + ' is byte-identical in both repos', function () {
            const local = fs.readFileSync(path.join(REPO_ROOT, rel));
            const twin = fs.readFileSync(path.join(DECODER_DIR, rel));
            expect(local.equals(twin), rel + ' has drifted from xchain-decoder at ' + firstDifferingLine(local, twin)).to.equal(true);
        });
    }
});
