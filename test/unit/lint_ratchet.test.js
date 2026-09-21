'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const {
    BASELINE_ERROR_COUNTS,
    checkResults,
} = require('../../bin/lint-ratchet');

function resultsFor(counts) {
    return [{
        messages: Object.entries(counts).flatMap(([ruleId, count]) => (
            Array.from({ length: count }, () => ({ ruleId, severity: 2 }))
        )),
    }];
}

describe('lint ratchet', () => {
    it('allows error counts equal to the baseline', () => {
        assert.doesNotThrow(() => checkResults(resultsFor(BASELINE_ERROR_COUNTS)));
    });

    it('allows error counts below the baseline', () => {
        const reduced = Object.fromEntries(
            Object.entries(BASELINE_ERROR_COUNTS).map(([ruleId, count]) => [ruleId, count - 1]),
        );

        assert.doesNotThrow(() => checkResults(resultsFor(reduced)));
    });

    it('rejects an increase above the per-rule baseline', () => {
        const increased = {
            ...BASELINE_ERROR_COUNTS,
            camelcase: BASELINE_ERROR_COUNTS.camelcase + 1,
        };

        assert.throws(
            () => checkResults(resultsFor(increased)),
            /camelcase: 68 error\(s\), baseline 67/,
        );
    });

    it('rejects errors from a rule absent from the baseline', () => {
        assert.throws(
            () => checkResults(resultsFor({ ...BASELINE_ERROR_COUNTS, 'new-rule': 1 })),
            /new-rule: new rule with 1 error\(s\)/,
        );
    });

    it('runs the CLI against src, test, and bin exactly', () => {
        const fixtureDirectory = mkdtempSync(path.join(tmpdir(), 'lint-ratchet-'));
        const preloadPath = path.join(fixtureDirectory, 'preload.js');
        const targetsPath = path.join(fixtureDirectory, 'targets.json');
        const scriptPath = path.resolve(__dirname, '../../bin/lint-ratchet.js');
        const preload = [
            "const Module = require('node:module');",
            "const { writeFileSync } = require('node:fs');",
            'const originalLoad = Module._load;',
            'Module._load = function load(request, parent, isMain) {',
            "    if (request === 'eslint') {",
            '        return { ESLint: class FakeESLint {',
            '            async lintFiles(targets) {',
            '                writeFileSync(process.env.LINT_RATCHET_TARGETS_PATH, JSON.stringify(targets));',
            '                return [];',
            '            }',
            '        } };',
            '    }',
            '    return originalLoad.call(this, request, parent, isMain);',
            '};',
        ].join('\n');

        writeFileSync(preloadPath, preload);

        try {
            const child = spawnSync(process.execPath, ['--require', preloadPath, scriptPath], {
                encoding: 'utf8',
                env: { ...process.env, LINT_RATCHET_TARGETS_PATH: targetsPath },
            });

            assert.equal(child.status, 0, child.stderr);
            assert.deepEqual(JSON.parse(readFileSync(targetsPath, 'utf8')), ['src', 'test', 'bin']);
        } finally {
            rmSync(fixtureDirectory, { recursive: true, force: true });
        }
    });
});
