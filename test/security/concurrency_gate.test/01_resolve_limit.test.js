/*
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 * Security: global in-flight concurrency cap.
 *
 * The tracker's per-IP rate limiter cannot see a stampede spread across many
 * source IPs: every bucket stays under its own limit while the process burns
 * all of its LevelDB read throughput on address scans. These tests drive the
 * real gate over real HTTP with a DISTINCT forged client IP per request, so a
 * shed can only come from the global cap - the per-IP limiter is mounted
 * alongside at its production default and never fires.
 *
 * Run: mocha test/security/concurrency_gate.test.js --timeout 5000
 */

'use strict';

const { expect } = require('chai');
const { resolveLimit } = require('../../../src/server/concurrency_gate.js');
const { captureLog } = require('../../helpers/capture_log');
const { closeServers } = require('../support/concurrency_gate_harness');

describe('Security: global in-flight concurrency cap', function () {
    afterEach(closeServers);

    describe('resolveLimit', function () {

        it('keeps the caller default when the env var is unset or unparseable', function () {
            // A typo must not silently remove the cap.
            expect(resolveLimit(undefined, 100)).to.equal(100);
            expect(resolveLimit('', 100)).to.equal(100);
            expect(resolveLimit('lots', 100)).to.equal(100);
        });

        it('honours an explicit value and treats <= 0 as disabled', function () {
            expect(resolveLimit('25', 100)).to.equal(25);
            expect(resolveLimit('0', 100)).to.equal(0);
            expect(resolveLimit('-5', 100)).to.equal(0);
        });

        // The blind spot that hid item 7713: 'lots' is the one malformed shape
        // parseInt DOES reject, so the case above passed while the shapes an
        // operator actually typos went the other way. parseInt reads a numeric
        // PREFIX, so '0oops' and '0.5' parsed to 0, Number.isFinite(0) is true,
        // the caller's default was skipped, and the <= 0 escape hatch disabled
        // admission control outright.
        it('keeps the default for a prefix-numeric or fractional typo, rather than disabling the gate', function () {
            // The control: this is what the replaced arithmetic produced.
            expect(parseInt('0oops', 10)).to.equal(0);
            expect(parseInt('0.5', 10)).to.equal(0);
            expect(Number.isFinite(parseInt('0oops', 10))).to.equal(true);

            // resolveLimit warns through the shared logger at error level.
            const warned = [];
            const release = captureLog(['error'], (level, msg) => warned.push(msg));
            try {
                for (const bad of ['0oops', '0.5', '16abc', '1e', '2.9']) {
                    expect(resolveLimit(bad, 100), 'resolveLimit should have refused ' + bad).to.equal(100);
                    expect(resolveLimit(bad, 16),  'resolveLimit should have refused ' + bad).to.equal(16);
                }
            } finally {
                release();
            }
            expect(warned.join('\n')).to.match(/is not an integer/);
        });

        it('still trims a well-formed value and keeps the deliberate 0 hatch', function () {
            expect(resolveLimit(' 25 ', 100)).to.equal(25);
            expect(resolveLimit(' 0 ', 100)).to.equal(0);
            expect(resolveLimit(null, 100)).to.equal(100);
        });
    });
});
