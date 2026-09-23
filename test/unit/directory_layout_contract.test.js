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

// Regression: the snake_case migration of src/ and test/ moved every
// kebab-case and camelCase source path into its current home and split the
// old src/config.js monolith into src/config/. Nothing re-checked that the
// old paths stay gone once the rename lands, so a later patch could restore
// an old-named file alongside its replacement without any test noticing.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '../..');

function exists(relativePath) {
    return fs.existsSync(path.join(REPO_ROOT, relativePath));
}

// Representative sample of the rename, not the full census: one file per
// migrated top-level area, so a regression in any area trips this test
// without hand-maintaining a list that itself goes stale on the next move.
const RETIRED_TO_CURRENT = {
    'src/BlockchainConnector.js': 'src/chain/blockchain_connector.js',
    'src/LevelUpDb.js': 'src/store/level_up_db.js',
    'src/env-int.js': 'src/config/env_int.js',
    'src/utxoTrackerMetrics.js': 'src/server/utxo_tracker_metrics.js',
    'src/bulk-sync/dump.js': 'src/bulk_sync/dump.js',
};

// The 22 test helper/support files the M1/M2 renames left untouched: every
// basename here is the ORIGINAL name, only reachable at its current
// directory. A rename that swept one of these up by mistake removes it from
// this list's paths without adding a replacement, which the count guard
// below catches even if the specific path were left out by accident.
const UNRENAMED_SUPPORT_FILES = [
    'test/chaos/support/chaos_helpers.js',
    'test/conformance/support/generate_utxo_record_fixture.js',
    'test/e2e/support/helpers.js',
    'test/fuzz/support/helpers.js',
    'test/helpers/capture_log.js',
    'test/helpers/ondisk_classiclevel_hook.js',
    'test/helpers/setup.js',
    'test/integration/support/helpers.js',
    'test/manual/bulk_sync/merger/support/smoke_derive_keys.js',
    'test/manual/bulk_sync/merger/support/smoke_external_sort.js',
    'test/manual/bulk_sync/merger/support/smoke_loader.js',
    'test/manual/bulk_sync/merger/support/smoke_streaming_join.js',
    'test/manual/bulk_sync/support/smoke_process_block.js',
    'test/manual/bulk_sync/support/smoke_writers.js',
    'test/manual/bulk_sync/support/smoke_xdmp_reader.js',
    'test/mutation/stryker-plugins/support/run_custom_mutants.js',
    'test/performance/support/helpers.js',
    'test/performance/support/mainnet_scale_db.js',
    'test/security/support/concurrency_gate_harness.js',
    'test/unit/api.test/support/test_app.js',
    'test/unit/blockchain_connector.test/support/auxpow_builders.js',
    'test/unit/sync_loop/support/harness.js',
];

describe('directory layout contract', () => {
    it('keeps the retired kebab-case and camelCase paths gone', () => {
        for (const retired of Object.keys(RETIRED_TO_CURRENT)) {
            assert.equal(exists(retired), false, `retired path is back: ${retired}`);
        }
    });

    it('keeps the current snake_case path for each sampled rename', () => {
        for (const current of Object.values(RETIRED_TO_CURRENT)) {
            assert.equal(exists(current), true, `renamed path is missing: ${current}`);
        }
    });

    it('has no leftover kebab-case src/bulk-sync directory', () => {
        assert.equal(exists('src/bulk-sync'), false);
        assert.equal(exists('src/bulk_sync'), true);
    });

    it('keeps env parsing split into src/config/, not a src/config.js monolith', () => {
        assert.equal(exists('src/config.js'), false);
        assert.equal(exists('src/config/index.js'), true);
        assert.equal(exists('src/config/env_int.js'), true);

        const config = require('../../src/config');
        const { readInt, envInt } = require('../../src/config/env_int');
        assert.equal(Object.prototype.hasOwnProperty.call(config, 'NODE_RPC_TIMEOUT_MS'), true);
        assert.equal(typeof readInt, 'function');
        assert.equal(typeof envInt, 'function');
    });

    it('leaves all 22 non-suite support files at their original basename', () => {
        // Exact count, not "at least": a swept-up file drops the count as
        // surely as a moved one, so a plain existence loop can't miss it.
        assert.equal(UNRENAMED_SUPPORT_FILES.length, 22);
        for (const supportFile of UNRENAMED_SUPPORT_FILES) {
            assert.equal(exists(supportFile), true, `support file missing or renamed: ${supportFile}`);
        }
    });
});
