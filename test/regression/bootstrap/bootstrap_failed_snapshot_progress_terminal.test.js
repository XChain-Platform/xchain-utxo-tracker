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

const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');
const childProcess = require('child_process');
const { expect } = require('chai');
const { handleBootstrapFailure } = require('../../../src/bootstrap/bootstrap_recovery.js');

const COMPRESSION_PATH = require.resolve('../../../src/api/compression.js');

function loadCompressionWithStubbedSpawn(stub) {
    const realSpawn = childProcess.spawn;
    const cached = require.cache[COMPRESSION_PATH];
    childProcess.spawn = stub;
    delete require.cache[COMPRESSION_PATH];
    try {
        return require(COMPRESSION_PATH);
    } finally {
        childProcess.spawn = realSpawn;
        delete require.cache[COMPRESSION_PATH];
        if (cached) require.cache[COMPRESSION_PATH] = cached;
    }
}

function fakeChild() {
    const child = new EventEmitter();
    child.stdin = new Writable({ write(chunk, encoding, callback) { callback(); } });
    child.stdout = new PassThrough();
    child.stderr = new EventEmitter();
    return child;
}

describe('failed bootstrap progress is terminal', function () {
    it('ignores progress delivered after snapshot failure is recorded', async function () {
        let pv;
        const spawn = (command) => {
            const child = fakeChild();
            if (command === 'du') {
                setImmediate(() => {
                    child.stdout.emit('data', Buffer.from('1024\t/data/xchain\n'));
                    child.emit('close', 0);
                });
            } else if (command === 'pv') {
                pv = child;
            }
            return child;
        };
        const { compressDirPigz, tasks } = loadCompressionWithStubbedSpawn(spawn);
        const taskId = 'failed-progress-' + Date.now();
        const destination = path.join(os.tmpdir(), taskId, 'missing', 'snapshot.tar.gz');

        let failure;
        try {
            await compressDirPigz(taskId, '/data/xchain', destination);
        } catch (err) {
            failure = err;
        }
        expect(failure).to.be.an('error').with.property('message').that.includes('snapshot write failed');

        handleBootstrapFailure({ tasks, taskId, error: failure, relaunch() {}, log() {} });
        pv.stderr.emit('data', Buffer.from('87\n'));

        expect(tasks[taskId].progress).to.equal(-1);
        expect(tasks[taskId].error).to.include('snapshot write failed');
    });
});
