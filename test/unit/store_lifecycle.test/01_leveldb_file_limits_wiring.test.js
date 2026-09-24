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

// createDatabase() hands cacheSize/writeBufferSize/maxOpenFiles/maxFileSize
// straight to the ClassicLevel constructor. The native binding does not expose
// what it was constructed with, so this stubs the constructor itself (same
// require-cache-reload technique as memory_budget.test.js) to capture the
// options object rather than asserting on engine-internal behaviour.

'use strict';

const { expect } = require('chai');

const CLASSIC_LEVEL_PATH = require.resolve('classic-level');
const STORE_LIFECYCLE_PATH = require.resolve('../../../src/store/level_up_db/store_lifecycle');

function withEnv(overrides, fn) {
    const prev = {};
    for (const key of Object.keys(overrides)) {
        prev[key] = Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined;
        if (overrides[key] === undefined) delete process.env[key];
        else process.env[key] = overrides[key];
    }
    try {
        return fn();
    } finally {
        for (const key of Object.keys(overrides)) {
            if (prev[key] === undefined) delete process.env[key];
            else process.env[key] = prev[key];
        }
    }
}

async function captureCreateDatabaseOptions() {
    const classicLevelExports = require(CLASSIC_LEVEL_PATH);
    const RealClassicLevel = classicLevelExports.ClassicLevel;
    let captured = null;
    class FakeClassicLevel {
        constructor(location, options) { captured = options; }
        async open() {}
    }
    classicLevelExports.ClassicLevel = FakeClassicLevel;
    delete require.cache[STORE_LIFECYCLE_PATH];

    try {
        const storeLifecycle = require(STORE_LIFECYCLE_PATH);
        await storeLifecycle.createDatabase.call({ dbName: 'leveldb-file-limits-test', inMemory: false });
        return captured;
    } finally {
        classicLevelExports.ClassicLevel = RealClassicLevel;
        delete require.cache[STORE_LIFECYCLE_PATH];
    }
}

describe('store_lifecycle createDatabase LevelDB file-limit wiring', function () {

    it('passes the config defaults through to ClassicLevel when unset', async function () {
        const options = await withEnv(
            { LEVELDB_MAX_OPEN_FILES: undefined, LEVELDB_MAX_FILE_SIZE_BYTES: undefined },
            captureCreateDatabaseOptions
        );
        expect(options.maxOpenFiles).to.equal(1000);
        expect(options.maxFileSize).to.equal(2 * 1024 * 1024);
    });

    it('passes an operator override through to ClassicLevel', async function () {
        const options = await withEnv(
            { LEVELDB_MAX_OPEN_FILES: '512', LEVELDB_MAX_FILE_SIZE_BYTES: String(4 * 1024 * 1024) },
            captureCreateDatabaseOptions
        );
        expect(options.maxOpenFiles).to.equal(512);
        expect(options.maxFileSize).to.equal(4 * 1024 * 1024);
    });
});
