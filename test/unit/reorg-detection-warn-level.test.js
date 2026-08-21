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

// Tip-divergence detections must be announced at warn level. Nothing in this
// service routes the block-sync loop through the structured logger, so the
// console METHOD is the severity: a collector that splits stdout from stderr,
// or filters warn-and-above, files a console.log reorg as routine progress.
//
// These branches need a live node and a real divergence to reach, so this is a
// source-level drift guard in the shape of test/unit/no-key-boot-warning.test.js:
// it pins the console method each detection message is emitted with.

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

describe('reorg detection log severity @regression', function () {
    const src = fs.readFileSync(path.join(__dirname, '../../src/XChainUtxoTracker.js'), 'utf8');

    // Message prefixes, each unique in the file. Matched against the call that
    // emits them rather than by line number, which drifts on every edit.
    const DETECTIONS = [
        'WARNING! The last processed block height (',
        'A same-height tip reorg has been detected.',
        'A reorg has been detected.'
    ];

    // The console method a given message literal is emitted with, or null when the
    // message is absent. Reads backwards from the literal to the console.<method>(
    // that opens the call, allowing the opening quote of the string literal.
    function methodFor(message) {
        const at = src.indexOf(message);
        if (at === -1) return null;
        const m = src.slice(0, at).match(/console\.(log|warn|error)\(\s*["'`]$/);
        return m ? m[1] : null;
    }

    for (const message of DETECTIONS) {
        it('warns rather than logs: "' + message.slice(0, 40) + '..."', function () {
            const method = methodFor(message);
            assert.ok(method !== null,
                'detection message no longer present in src/XChainUtxoTracker.js: ' + message);
            assert.strictEqual(method, 'warn',
                'tip-divergence detections must use console.warn so a reorg leaves a ' +
                'warn-level record even if verifyReorg wedges before the metrics advance; ' +
                'found console.' + method + ' for: ' + message);
        });
    }

    it('leaves the neighbouring progress and error lines alone', function () {
        // Progress output stays info: promoting these is pure alert noise.
        assert.strictEqual(methodFor('Last block index was fixed!'), 'log');
        // The tip-hash re-check failure is a genuine error and stays one.
        assert.strictEqual(methodFor('Error re-checking the committed tip hash from node: '), 'error');
    });
});
