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
 **********************************************************************
 * Shared eslint flat config for the xchain-* service repos: the file-level
 * half of the code-style rules, for editors and `npm run lint`.
 *
 * VENDORED COPY. The platform holds the master and every service copies it
 * rather than importing it, because a public clone has no platform tree beside
 * it to import from. Everything above the repo-specific block at the bottom is
 * the master verbatim; refresh it by re-copying and re-applying that block.
 *
 * The pre-push gate (check-code-structure.js) does not depend on eslint or
 * on this file; the two agree on the rules but the gate is what binds.
 */
'use strict';

const src = {
    files: ['src/**/*.js'],
    languageOptions: {
        ecmaVersion: 2023,
        sourceType: 'commonjs',
        globals: {
            require: 'readonly', module: 'writable', exports: 'writable', process: 'readonly', Buffer: 'readonly',
            __dirname: 'readonly', __filename: 'readonly', console: 'readonly', setTimeout: 'readonly',
            clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly', setImmediate: 'readonly',
            URL: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly', AbortController: 'readonly',
        },
    },
    rules: {
        // Naming: camelCase everywhere except property keys, which carry
        // protocol fields and DB columns through one-to-one.
        camelcase: ['error', { properties: 'never', ignoreDestructuring: true, ignoreImports: true }],
        'no-underscore-dangle': ['error', { enforceInMethodNames: true, allowAfterThis: false, allowFunctionParams: false }],
        // Logging: one logger. Entry points override this below.
        'no-console': 'error',
        // Module shape: requires at the top, environment in config.js only,
        // one export shape per file.
        'no-restricted-syntax': ['error',
            {
                selector: ':function CallExpression[callee.name="require"][arguments.0.type="Literal"]',
                message: 'require() at the top of the file; inside a body only for a computed path (CODE-STYLE.md, Module shape)',
            },
            {
                selector: 'MemberExpression[object.name="process"][property.name="env"]',
                message: 'environment is read in config.js only (CODE-STYLE.md, Module shape)',
            },
        ],
        'prefer-const': 'error',
        'no-var': 'error',
        eqeqeq: ['error', 'smart'],
    },
};

const configAndEntry = {
    files: ['src/config.js', 'src/api.js', 'src/migrate.js', 'src/index.js', 'bin/**/*.js'],
    rules: {
        'no-console': 'off',
        'no-restricted-syntax': ['error',
            {
                selector: ':function CallExpression[callee.name="require"][arguments.0.type="Literal"]',
                message: 'require() at the top of the file; inside a body only for a computed path (CODE-STYLE.md, Module shape)',
            },
        ],
    },
};

const tests = {
    files: ['test/**/*.js'],
    languageOptions: src.languageOptions,
    rules: {
        camelcase: src.rules.camelcase,
        'no-underscore-dangle': src.rules['no-underscore-dangle'],
        'prefer-const': 'error',
        'no-var': 'error',
    },
};

// Everything below this line is this repo's own; everything above is the shared preset.

// The two vendored trees. src/coins/ and src/observability/ are refreshed from
// a canonical elsewhere by a sync script, so an error reported here is an
// error nobody in this repo is allowed to fix, and a lint that reports it
// trains its readers to ignore it.
const vendored = {
    ignores: ['src/coins/**', 'src/observability/**'],
};

// Programs rather than modules. The offline bootstrap pipeline under
// src/bulk_sync/ is nine commands an operator types; their console output IS
// their result and they read their own argv, so the logger rule and the
// environment rule would both be reporting a design, not a defect.
const bootstrapTools = {
    files: ['src/bulk_sync/**/*.js', 'test/manual/**/*.js'],
    rules: {
        'no-console': 'off',
        'no-restricted-syntax': ['error',
            {
                selector: ':function CallExpression[callee.name="require"][arguments.0.type="Literal"]',
                message: 'require() at the top of the file; inside a body only for a computed path (CODE-STYLE.md, Module shape)',
            },
        ],
    },
};

// The config home this service actually has. The shared block names src/config.js
// because that is the common shape; here the home is a directory, and the
// environment rule has to exempt the file that does the reading or there is
// nowhere compliant to read from.
const configHome = {
    files: ['src/config/**/*.js'],
    rules: configAndEntry.rules,
};

module.exports = [vendored, src, configAndEntry, bootstrapTools, configHome, tests];
