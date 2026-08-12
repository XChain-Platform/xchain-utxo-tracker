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

// Regression: an invalid source size must not erase its own bootstrap task
// record. getbootstrap starts compressDirPigz and routes the rejection
// through handleBootstrapFailure, whose recordFailure is guarded on
// tasks[taskId] and silently no-ops when the record is missing.
// compressDirPigz's invalid-du-size branch used to `delete tasks[taskId]`
// immediately before throwing, so progress -1 and the error were never
// recorded and getbootstrapstatus answered "taskid doesn't exist" instead of
// the real failure. Other regression tests for this task-record class all
// call handleBootstrapFailure with the record already present, which is
// exactly the precondition this bug violated, so none of them could catch it.
//
// The du process is stubbed rather than run, so the test exercises the real
// compressDirPigz control flow without touching /data or spawning tar/pv/pigz
// (the throw happens before those are spawned).

const path = require('path');
const { EventEmitter } = require('events');
const childProcess = require('child_process');
const { expect } = require('chai');
const { handleBootstrapFailure } = require('../../src/bootstrap-recovery');

const API_PATH = require.resolve('../../src/api.js');

// api.js destructures `spawn` from child_process at require time, so the stub has
// to be installed before the module is loaded. Load a private instance around the
// stub and drop it from the cache afterwards, so neither the stub nor this second
// instance leaks into any other test file's copy of api.js.
function loadApiWithStubbedSpawn(stub) {
    const realSpawn = childProcess.spawn;
    const hadCached = Object.prototype.hasOwnProperty.call(require.cache, API_PATH);
    const cached = require.cache[API_PATH];
    childProcess.spawn = stub;
    delete require.cache[API_PATH];
    try {
        return require(API_PATH);
    } finally {
        childProcess.spawn = realSpawn;
        delete require.cache[API_PATH];
        if (hadCached) require.cache[API_PATH] = cached;
    }
}

// A `du -sb` that exits 0 but prints something parseInt cannot read, which is the
// branch under test (a garbled/localised du, or a du that printed nothing).
function stubDuEmitting(text) {
    return function spawnStub(cmd) {
        if (cmd !== 'du') {
            throw new Error(`bootstrap-invalid-size regression: unexpected spawn of '${cmd}'; ` +
                'the invalid-size branch must throw before tar/pv/pigz are started');
        }
        const proc = new EventEmitter();
        proc.stdout = new EventEmitter();
        setImmediate(() => {
            proc.stdout.emit('data', Buffer.from(text));
            proc.emit('close', 0);
        });
        return proc;
    };
}

describe('invalid source size keeps its bootstrap task record', function () {

    it('leaves the task record in place so handleBootstrapFailure can stamp progress -1 and the error', async function () {
        const api = loadApiWithStubbedSpawn(stubDuEmitting('notanumber\t/data/xchain\n'));
        const { compressDirPigz, bootstrapTasks } = api;
        expect(compressDirPigz, 'src/api.js must export compressDirPigz for this guard').to.be.a('function');

        const taskId = 'regression-4371-invalid-size';
        let thrown = null;
        try {
            await compressDirPigz(taskId, '/data/xchain', path.join('/bootstrap', 'never-written.tar.gz'));
        } catch (err) {
            thrown = err;
        }

        expect(thrown, 'an unparsable du size must reject').to.be.an('error');
        expect(thrown.message).to.match(/Invalid size for source/);

        // The bug: the record was deleted before the throw, so the failure handler
        // below found nothing to stamp.
        expect(bootstrapTasks, 'the task record must survive the throw')
            .to.have.property(taskId);

        let relaunched = 0;
        handleBootstrapFailure({
            tasks: bootstrapTasks, taskId, error: thrown,
            relaunch: () => { relaunched++; },
            log: () => {}
        });

        expect(relaunched, 'indexing must resume; /data was never touched').to.equal(1);
        expect(bootstrapTasks[taskId].progress, 'getbootstrapstatus reads progress -1 as "failed"').to.equal(-1);
        expect(bootstrapTasks[taskId].error).to.match(/Invalid size for source/);
    });

    // Source guard: the fix is the ABSENCE of a statement, which a behavioural
    // assertion alone cannot pin against a well-meaning re-add.
    it('compressDirPigz contains no delete of its own task record', function () {
        const fs = require('fs');
        const src = fs.readFileSync(API_PATH, 'utf8');
        const start = src.indexOf('async function compressDirPigz(');
        expect(start, 'compressDirPigz must exist in src/api.js').to.be.greaterThan(-1);
        const body = src.slice(start, src.indexOf('\n}', start));
        expect(body).to.match(/Invalid size for source/);
        expect(body, 'the failure handler owns the record; compressDirPigz must not delete it')
            .to.not.match(/delete\s+tasks\[/);
    });
});
