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

/*********************************************************************
 * test/unit/no-key-boot-warning.test.js
 *
 * : platform-wide no-API-key posture. Running keyless is allowed,
 * but the open/closed state must be announced loudly at boot. api.js
 * cannot be require()d in tests (it self-starts and hits real env vars),
 * so this is a source-level drift guard: the keyless branch and its
 * console.warn must stay present in src/api.js.
 *********************************************************************/

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

describe('no-API-key boot warning  @regression', function () {
    const src = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');

    it('warns at boot when UTXO_TRACKER_API_KEY is unset', function () {
        assert.ok(/if\s*\(\s*!UTXO_TRACKER_API_KEY\s*\)\s*\{\s*\n\s*console\.warn\(\s*'WARNING: UTXO_TRACKER_API_KEY is not set/.test(src),
            'src/api.js must print a loud startup warning when UTXO_TRACKER_API_KEY is unset (see operations/API_KEYS.md)');
    });

    it('the warning states that admin methods fail closed and reads stay open', function () {
        assert.ok(src.includes('fail closed'), 'warning must state the admin surface fails closed');
        assert.ok(src.includes('read-only UTXO/balance queries remain open'),
            'warning must state the read surface stays open');
    });
});
