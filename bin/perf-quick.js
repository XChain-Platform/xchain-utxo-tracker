#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');

const MOCHA = require.resolve('mocha/bin/mocha.js');
const MOCHA_ARGS = [
    MOCHA,
    '--timeout', '0',
    '--recursive',
    'test/performance/**/*.test.js',
    '--exit',
];

function runAttempt(spawn) {
    return spawn(process.execPath, MOCHA_ARGS, {
        env: { ...process.env, PERF_SCALE: 'small' },
        stdio: 'inherit',
    });
}

function resultCode(result) {
    return Number.isInteger(result.status) ? result.status : 1;
}

function run(spawn = spawnSync, report = console.error) {
    const first = runAttempt(spawn);
    if (resultCode(first) === 0) return 0;

    report('perf:quick: first attempt failed; retrying once in a clean process');
    return resultCode(runAttempt(spawn));
}

if (require.main === module) process.exitCode = run();

module.exports = { MOCHA_ARGS, resultCode, run };
