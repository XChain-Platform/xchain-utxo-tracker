#!/usr/bin/env node
'use strict';

const { ESLint } = require('eslint');

const BASELINE_ERROR_COUNTS = Object.freeze({
    camelcase: 67,
    'prefer-const': 112,
    eqeqeq: 24,
    'no-var': 8,
    'no-underscore-dangle': 340,
    'no-restricted-syntax': 5,
    'no-console': 2,
});

const LINT_TARGETS = Object.freeze(['src', 'test', 'bin']);

function checkResults(results) {
    const counts = {};

    for (const result of results) {
        for (const message of result.messages) {
            if (message.severity !== 2) continue;
            const ruleId = message.ruleId || '<unknown>';
            counts[ruleId] = (counts[ruleId] || 0) + 1;
        }
    }

    const regressions = [];
    for (const [ruleId, count] of Object.entries(counts)) {
        if (!Object.hasOwn(BASELINE_ERROR_COUNTS, ruleId)) {
            regressions.push(`${ruleId}: new rule with ${count} error(s)`);
        } else if (count > BASELINE_ERROR_COUNTS[ruleId]) {
            regressions.push(`${ruleId}: ${count} error(s), baseline ${BASELINE_ERROR_COUNTS[ruleId]}`);
        }
    }

    if (regressions.length) {
        throw new Error(`Lint ratchet failed:\n${regressions.join('\n')}`);
    }

    return counts;
}

async function run(ESLintClass = ESLint) {
    const eslint = new ESLintClass();
    const results = await eslint.lintFiles(LINT_TARGETS);
    return checkResults(results);
}

if (require.main === module) {
    run().then(() => {
        console.log('Lint error counts are at or below baseline.');
    }).catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = { BASELINE_ERROR_COUNTS, checkResults, run };
