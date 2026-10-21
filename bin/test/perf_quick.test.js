'use strict';

const assert = require('assert');
const { MOCHA_ARGS, resultCode, run } = require('../perf-quick.js');

function scriptedSpawn(statuses, calls) {
    return (command, args, options) => {
        calls.push({ command, args, options });
        return { status: statuses.shift() };
    };
}

describe('bin/perf-quick.js', function () {
    it('runs the quick performance suite once when it passes', function () {
        const calls = [];
        const reports = [];
        const code = run(scriptedSpawn([0], calls), (message) => reports.push(message));

        assert.strictEqual(code, 0);
        assert.strictEqual(calls.length, 1);
        assert.deepStrictEqual(calls[0].args, MOCHA_ARGS);
        assert.strictEqual(calls[0].options.env.PERF_SCALE, 'small');
        assert.strictEqual(calls[0].options.stdio, 'inherit');
        assert.deepStrictEqual(reports, []);
    });

    it('retries a failed suite in a clean process and accepts the retry', function () {
        const calls = [];
        const reports = [];
        const code = run(scriptedSpawn([1, 0], calls), (message) => reports.push(message));

        assert.strictEqual(code, 0);
        assert.strictEqual(calls.length, 2);
        assert.strictEqual(reports.length, 1);
        assert.match(reports[0], /retrying once/);
    });

    it('returns the second failure so a repeatable regression stays red', function () {
        const calls = [];
        const code = run(scriptedSpawn([1, 7], calls), () => {});

        assert.strictEqual(code, 7);
        assert.strictEqual(calls.length, 2);
    });

    it('maps a signal or launch failure to a nonzero exit code', function () {
        assert.strictEqual(resultCode({ status: null, signal: 'SIGTERM' }), 1);
    });
});
