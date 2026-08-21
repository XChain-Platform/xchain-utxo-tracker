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

// Regression: a malformed BULK_SYNC_* env must not silently disarm the
// bulk-sync pre-flight.
//
// BULK_SYNC_TIP_SAFETY was held as the raw env STRING and run through parseInt
// inside runBulkSyncIfEmpty. A non-numeric value made that parseInt NaN,
// Math.max(NaN, undoBlocks) NaN, and `info.blocks < NaN` false for every chain
// height, so the too-short-chain guard passed by never firing. The orchestrator
// was then spawned with --tip-safety <garbage>, which dump.js validateArgs
// refuses as a FATAL: one typo turned the designed graceful fallback to
// incremental sync into a crash-loop before startApi().
//
// The env boundary now validates (envInt) with the same warn-and-default shape
// resolveUndoBlocks applies to XCHAIN_UNDO_BLOCKS_<COIN>.

const { expect } = require('chai');
const fs   = require('fs');
const path = require('path');
const { envInt } = require('../../src/api');
const { resolveUndoBlocks } = require('../../src/undo-blocks');

const API_SRC = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');

// Swallow the deliberate warnings so a rejection case does not spray the reporter.
function quietly(fn) {
    const prev  = console.error;
    const lines = [];
    console.error = (...a) => lines.push(a.join(' '));
    try { return { value: fn(), lines }; }
    finally { console.error = prev; }
}

function withEnv(name, value, fn) {
    const had  = Object.prototype.hasOwnProperty.call(process.env, name);
    const prev = process.env[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    try { return fn(); }
    finally {
        if (had) process.env[name] = prev;
        else delete process.env[name];
    }
}

describe('bulk-sync env validation @regression', function () {

    const KNOB = 'BULK_SYNC_TIP_SAFETY__TEST';

    it('returns the default when the knob is unset or blank', function () {
        expect(withEnv(KNOB, undefined, () => envInt(KNOB, 10, 0))).to.equal(10);
        expect(withEnv(KNOB, '',        () => envInt(KNOB, 10, 0))).to.equal(10);
        expect(withEnv(KNOB, '   ',     () => envInt(KNOB, 10, 0))).to.equal(10);
    });

    it('honors a well-formed operator override', function () {
        expect(withEnv(KNOB, '25',  () => envInt(KNOB, 10, 0))).to.equal(25);
        expect(withEnv(KNOB, ' 0 ', () => envInt(KNOB, 10, 0))).to.equal(0);
    });

    it('refuses a malformed value, warns, and keeps the default', function () {
        // '1O0' is the capital-O typo for '100': the shape parseInt read as 1.
        for (const bad of ['1O0', 'abc', '10.5', '1e', '', '-1']) {
            const { value, lines } = quietly(() => withEnv(KNOB, bad || undefined, () => envInt(KNOB, 10, 0)));
            expect(value, `envInt should have refused '${bad}'`).to.equal(10);
            if (bad !== '') expect(lines.join('\n')).to.match(/is not an integer/);
        }
    });

    it('refuses a value below the knob\'s floor', function () {
        const { value } = quietly(() => withEnv(KNOB, '0', () => envInt(KNOB, 6, 1)));
        expect(value).to.equal(6);
    });

    // The control this fix exists for: reproduce the ORIGINAL failure with the
    // old arithmetic, then show the validated value restores the guard.
    it('restores the too-short-chain guard a NaN tip-safety disarmed', function () {
        const undo = resolveUndoBlocks('bitcoin-mainnet');   // 12

        // BEFORE: raw env string -> parseInt -> NaN -> the comparison is false at
        // every chain height, so a 0-block regtest node sailed past the guard.
        const oldMin = Math.max(parseInt('ten', 10), undo) + 1;
        expect(Number.isNaN(oldMin)).to.equal(true);
        expect(0 < oldMin, 'the pre-flight fired before the fix').to.equal(false);

        // AFTER: the same env resolves to the default, and the guard fires.
        const newMin = quietly(() =>
            withEnv(KNOB, 'ten', () => Math.max(envInt(KNOB, 10, 0), undo) + 1)).value;
        expect(newMin).to.equal(undo + 1);
        expect(0 < newMin, 'the pre-flight must fire on a 0-block chain').to.equal(true);

        // The quieter half of the same bug, which parseInt never made NaN: '1O0'
        // (capital O for zero) READ as 1, so the guard stayed armed at the wrong
        // number and the orchestrator ran with a tip-safety the operator never set.
        expect(parseInt('1O0', 10)).to.equal(1);
        expect(quietly(() => withEnv(KNOB, '1O0', () => envInt(KNOB, 10, 0))).value).to.equal(10);
    });

    it('routes every BULK_SYNC_* numeric knob through the validator', function () {
        for (const knob of ['BULK_SYNC_WORKERS', 'BULK_SYNC_CHUNK_SIZE', 'BULK_SYNC_RAM_BUDGET',
                            'BULK_SYNC_TIP_SAFETY', 'BULK_SYNC_BATCH_SIZE']) {
            expect(API_SRC, `${knob} must be resolved through envInt`)
                .to.match(new RegExp(`const ${knob}\\s*=\\s*envInt\\('${knob}'`));
        }
    });

    it('no longer parseInts the tip-safety inside the pre-flight', function () {
        // The NaN entered here. A validated number reaches this line now, so a
        // reintroduced parseInt would be a regression, not a redundancy.
        expect(API_SRC).to.not.match(/parseInt\(BULK_SYNC_TIP_SAFETY/);
        expect(API_SRC).to.match(/Math\.max\(BULK_SYNC_TIP_SAFETY,\s*resolveUndoBlocks\(NETWORK\)\)/);
    });

    it('stringifies the validated knobs for the orchestrator argv', function () {
        // spawn refuses a non-string argv element, and these are numbers now.
        for (const [flag, knob] of [['--tip-safety', 'BULK_SYNC_TIP_SAFETY'],
                                    ['--chunk-size', 'BULK_SYNC_CHUNK_SIZE'],
                                    ['--workers',    'BULK_SYNC_WORKERS'],
                                    ['--ram-budget', 'BULK_SYNC_RAM_BUDGET'],
                                    ['--batch-size', 'BULK_SYNC_BATCH_SIZE']]) {
            expect(API_SRC, `${flag} must pass String(${knob})`)
                .to.include(`'${flag}',`);
            expect(API_SRC, `${flag} must pass String(${knob})`)
                .to.include(`String(${knob})`);
        }
    });
});
