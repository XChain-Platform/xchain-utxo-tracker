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

// Regression: the post-wipe delete failure must name the real fs reason. The
// restore status record and the fatal log are the operator's evidence after a
// partial /data wipe, and a message ending at the colon told them nothing.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { expect } = require('chai');
const { deleteFilesInDirectorySync } = require('../../../src/api/compression.js');
const { handleRestoreFailure } = require('../../../src/bootstrap/bootstrap_recovery');

function captureThrow(fn) {
    try { fn(); } catch (err) { return err; }
    throw new Error('expected a throw');
}

describe('Regression: deleteFilesInDirectorySync keeps the fs cause', function () {
    let scratch;

    beforeEach(function () {
        scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'utxo-delete-cause-'));
    });

    afterEach(function () {
        fs.rmSync(scratch, { recursive: true, force: true });
    });

    it('names ENOENT in the message and keeps the fs error as cause', function () {
        const missing = path.join(scratch, 'no-such-dir');
        const err = captureThrow(() => deleteFilesInDirectorySync(missing));

        expect(err.message).to.contain(missing);
        expect(err.message).to.contain('ENOENT');
        expect(err.message.endsWith(':')).to.equal(false);
        expect(err.cause).to.be.an('error');
        expect(err.cause.code).to.equal('ENOENT');
    });

    it('names ENOTDIR when handed a regular file', function () {
        const file = path.join(scratch, 'plain-file');
        fs.writeFileSync(file, 'x');
        const err = captureThrow(() => deleteFilesInDirectorySync(file));

        expect(err.cause.code).to.equal('ENOTDIR');
        expect(err.message).to.contain('ENOTDIR');
    });

    it('stays on the fail-loud branch and records the reason in the task', function () {
        const err = captureThrow(() => deleteFilesInDirectorySync(path.join(scratch, 'gone')));
        // No preWipe tag: this failure is reached after the wipe starts.
        expect(err).to.not.have.property('preWipe');

        const tasks = { t1: { progress: 0 } };
        let failedLoud = 0;
        handleRestoreFailure({ tasks, taskId: 't1', error: err, failLoud: () => { failedLoud++; }, log: () => {} });

        expect(failedLoud).to.equal(1);
        expect(tasks.t1.progress).to.equal(-1);
        expect(tasks.t1.error).to.contain('ENOENT');
    });
});
