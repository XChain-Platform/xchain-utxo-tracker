'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Captures the lines the code under test emits through the shared logger.
//
// Stubbing console.error or console.warn only sees a logger line while the
// console patch is NOT installed. Once any file in the same mocha process
// requires src/api.js without the test bootstrap, patchConsole binds the
// logger's sink to the ORIGINAL console methods, so a later stub of console
// sees nothing and a warning the code did emit reads as missing. `npm run ci`
// and `coverage:check` load no bootstrap, which is exactly that process.
//
// Hooking getLogger()'s shared object instead catches the line on both paths,
// and keying on the level keeps the severity pinned: a warning demoted to info
// is not captured as an error.

const { getLogger } = require('../../src/observability');

// levels: the levels to capture; any other level passes through to the logger
// unchanged. onLine(level, message) receives each captured line. Returns the
// release function, which a caller must run in a finally or an afterEach.
function captureLog(levels, onLine) {
    const logger = getLogger();
    const prev = logger.log;
    logger.log = function (level, msg, fields) {
        if (!levels.includes(level)) return prev.call(logger, level, msg, fields);
        onLine(level, String(msg));
        return null;
    };
    return function release() { logger.log = prev; };
}

module.exports = { captureLog };
