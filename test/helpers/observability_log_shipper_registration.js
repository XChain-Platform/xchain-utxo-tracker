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

const { expect } = require('chai');

const {
    createLogShipper, scrubMessage, REDACTED
} = require('../../src/observability/logShipper.js');
const {
    patchConsole, unpatchConsole, getLogger, getRegistry, installObservability
} = require('../../src/observability/index.js');

// A console-shaped sink so tests never write to the mocha output.
function fakeConsole() {
    const lines = { log: [], warn: [], error: [] };
    return {
        lines,
        log:   (m) => lines.log.push(m),
        warn:  (m) => lines.warn.push(m),
        error: (m) => lines.error.push(m)
    };
}

function registerTextFieldFormatTests() {
    it('renders ts, lowercase level, service tag, message, then key=value', function () {
        const sink = fakeConsole();
        const log = createLogShipper({ service: 'xchain-utxo-tracker', env: {}, console: sink });
        log.warn('PBFT_DROP', { reason: 'digest_mismatch', phase: 'prepare', round: 42 });
        expect(sink.lines.warn).to.have.lengthOf(1);
        expect(sink.lines.warn[0]).to.match(
            /^\d{4}-\d{2}-\d{2}T[\d:.]+Z warn \[xchain-utxo-tracker\] PBFT_DROP reason=digest_mismatch phase=prepare round=42$/
        );
    });

    it('keeps the level token lowercase so the server-monitor ERROR|FATAL grep does not match it', function () {
        const sink = fakeConsole();
        const log = createLogShipper({ service: 'svc', env: {}, console: sink });
        log.error('boom');
        // collect-snapshot.sh counts `grep -cE 'ERROR|FATAL'`. An uppercase
        // token would make every console.error line count and trip the crit
        // threshold fleet-wide on first deploy.
        expect(sink.lines.error[0]).to.not.match(/ERROR|FATAL/);
        expect(sink.lines.error[0]).to.include(' error [svc] boom');
    });

    it('puts the message immediately after the service tag so existing substring greps still match', function () {
        const sink = fakeConsole();
        const log = createLogShipper({ service: 'xchain-utxo-tracker', env: {}, console: sink });
        log.info('Oracle: Round 12 finalized');
        expect(sink.lines.log[0]).to.include('Oracle: Round 12 finalized');
    });

    it('quotes a value carrying whitespace, = or a quote, and leaves plain tokens bare', function () {
        const sink = fakeConsole();
        const log = createLogShipper({ service: 'svc', env: {}, console: sink });
        log.info('m', { plain: 'abc', spaced: 'a b', eq: 'k=v', num: 3, flag: true, nil: null });
        const line = sink.lines.log[0];
        expect(line).to.include('plain=abc');
        expect(line).to.include('spaced="a b"');
        expect(line).to.include('eq="k=v"');
        expect(line).to.include('num=3');
        expect(line).to.include('flag=true');
        expect(line).to.include('nil=null');
    });
}

function registerTextFieldSafetyTests() {
    it('redacts a credential-shaped field and an inline credential in the message', function () {
        const sink = fakeConsole();
        const log = createLogShipper({ service: 'svc', env: {}, console: sink });
        log.warn('connect failed password=hunter2', { db_password: 'hunter2', host: 'db1' });
        const line = sink.lines.warn[0];
        expect(line).to.not.include('hunter2');
        expect(line).to.include(REDACTED);
        expect(line).to.include('host=db1');
    });

    it('emits one NDJSON record per line under LOG_FORMAT=json', function () {
        const sink = fakeConsole();
        const log = createLogShipper({ service: 'svc', env: { LOG_FORMAT: 'json' }, console: sink });
        log.info('hello', { a: 1 });
        const parsed = JSON.parse(sink.lines.log[0]);
        expect(parsed).to.include({ level: 'info', service: 'svc', msg: 'hello', a: 1 });
        expect(parsed.ts).to.be.a('string');
    });

    it('silences info under LOG_LEVEL=warn while still emitting warn', function () {
        const sink = fakeConsole();
        const log = createLogShipper({ service: 'svc', env: { LOG_LEVEL: 'warn' }, console: sink });
        log.info('quiet');
        log.warn('loud');
        expect(sink.lines.log).to.have.lengthOf(0);
        expect(sink.lines.warn).to.have.lengthOf(1);
    });
}

function registerMessageRedactionTests() {
    // An env-validation failure prints the variable NAME and its value, and the
    // names the services use are all prefixed (HUB_DB_SECRET, INDEXER_DB_PASS,
    // db_password). A `\b`-anchored key never matches those, because `_` is a
    // word character and `\b` does not fire between two word characters. With
    // LOG_SHIP_* configured, an unscrubbed line goes off-box in the clear.
    const leaky = [
        ['prefixed env secret',   'Missing required environment variable: HUB_DB_SECRET=hunter2swordfish'],
        ['prefixed db pass',      'connect failed db_password=hunter2swordfish'],
        ['screaming env pass',    'INDEXER_DB_PASS=hunter2swordfish'],
        ['api key',               'HUB_API_KEY=hunter2swordfish'],
        ['keyed bearer',          'Authorization: Bearer eyJhbGciOi.SECRETPAYLOAD.sig'],
        ['bare bearer',           'sending Bearer eyJhbGciOi.SECRETPAYLOAD.sig upstream'],
        ['quoted mnemonic',       'mnemonic="correct horse battery staple"'],
    ];
    for (const [name, line] of leaky) {
        it(`scrubs a ${name}`, function () {
            const out = scrubMessage(line);
            expect(out).to.not.match(/hunter2swordfish|SECRETPAYLOAD|correct horse/);
            expect(out).to.include(REDACTED);
        });
    }

    it('redacts the token, not the word Bearer', function () {
        // The value group would otherwise capture "Bearer" and stop, leaving the
        // token itself in the clear immediately after a [redacted] marker that
        // makes the line look handled.
        const out = scrubMessage('Authorization: Bearer eyJhbGciOi.SECRETPAYLOAD.sig');
        expect(out).to.not.include('SECRETPAYLOAD');
    });

    it('leaves real operational lines untouched, hex identifiers included', function () {
        // Hub and indexer lines are full of legitimate 64-char hex (txids, block
        // hashes, state roots). A hex sweep here would gut the logs this work
        // exists to make readable.
        const keep = [
            'Oracle: Round 12 finalized with 4 of 5 votes',
            'StateAnchorPublisher: anchored bundle regtest @ 100 (txid a3f9bc21de)',
            'P2P: Invalid signature from xc1qexampleaddr; dropping message',
            'seed block=5 imported',
            'PBFT_DROP reason=digest_mismatch phase=prepare round=42'
        ];
        for (const line of keep) expect(scrubMessage(line)).to.equal(line);
    });
}

function registerConsoleRoutingTests() {
    it('routes console.* through the shim, mapping log to info', function () {
        const handle = patchConsole({ service: 'xchain-utxo-tracker', env: {} });
        const seen = [];
        // Read the shipper's own output by swapping its sink after the patch,
        // which is the only place the bound originals are reachable from.
        handle.logger.console = { log: (m) => seen.push(m), warn: (m) => seen.push(m), error: (m) => seen.push(m) };
        console.log('plain');
        console.warn('careful');
        console.error('bad');
        unpatchConsole();
        expect(seen[0]).to.match(/ info \[xchain-utxo-tracker\] plain$/);
        expect(seen[1]).to.match(/ warn \[xchain-utxo-tracker\] careful$/);
        expect(seen[2]).to.match(/ error \[xchain-utxo-tracker\] bad$/);
    });

    it('resolves printf format strings and keeps an Error stack, via util.format', function () {
        const handle = patchConsole({ service: 'svc', env: {} });
        const seen = [];
        handle.logger.console = { log: (m) => seen.push(m), warn: (m) => seen.push(m), error: (m) => seen.push(m) };
        console.log('round %d of %s', 7, 'oracle');
        console.error('crashed:', new Error('kaboom'));
        unpatchConsole();
        expect(seen[0]).to.include('round 7 of oracle');
        expect(seen[1]).to.include('kaboom');
        expect(seen[1]).to.include('Error');
    });

    it('does not recurse: the sink holds bound originals captured BEFORE the patch', function () {
        // `const orig = console` would hand the logger the very object about to
        // be replaced, so every line would re-enter the wrapper forever. The
        // proof is simply that a line completes and arrives once.
        const realLog = console.log;
        let depth = 0;
        let maxDepth = 0;
        console.log = (...a) => { depth += 1; maxDepth = Math.max(maxDepth, depth); depth -= 1; return realLog.apply(console, a); };
        const captured = console.log;
        try {
            patchConsole({ service: 'svc', env: {} });
            expect(console.log).to.not.equal(captured);
            console.log('one line');
            unpatchConsole();
        } finally {
            console.log = realLog;
        }
        expect(maxDepth).to.equal(1);
    });
}

function registerConsoleLifecycleTests() {
    it('no-ops under XCHAIN_LOG_PATCH=0 so test bootstraps see stock console', function () {
        const before = console.log;
        const handle = patchConsole({ service: 'svc', env: { XCHAIN_LOG_PATCH: '0' } });
        expect(handle.patched).to.equal(false);
        expect(console.log).to.equal(before);
    });

    it('is idempotent and restores the exact original functions on unpatch', function () {
        const before = { log: console.log, warn: console.warn, error: console.error };
        const first = patchConsole({ service: 'svc', env: {} });
        const second = patchConsole({ service: 'other', env: {} });
        expect(second).to.equal(first);
        unpatchConsole();
        expect(console.log).to.equal(before.log);
        expect(console.warn).to.equal(before.warn);
        expect(console.error).to.equal(before.error);
    });

    it('getLogger works before any install and reaches the real shipper after', function () {
        // A module that logs while being required must not be able to crash the
        // process just because it loaded before the wiring.
        const log = getLogger();
        expect(() => log.info('early', { a: 1 })).to.not.throw();
        const handle = patchConsole({ service: 'svc', env: {} });
        const seen = [];
        handle.logger.console = { log: (m) => seen.push(m), warn: (m) => seen.push(m), error: (m) => seen.push(m) };
        log.warn('LATE_EVENT', { reason: 'x' });
        unpatchConsole();
        expect(seen[0]).to.match(/ warn \[svc\] LATE_EVENT reason=x$/);
    });

    // A trailing Error argument expands across lines under util.inspect, and only
    // the first line carries the prefix. Measured on the live fleet as orphaned
    // fragments like "  fatal: true," from a pretty-printed mariadb SqlError:
    // no operation, no error, no coin, and unparseable by anything keying on the
    // prefix. One console call must be one line.
    it('renders a multi-line message as ONE line with the breaks escaped', () => {
        const sink = fakeConsole();
        const log = createLogShipper({ service: 'xchain-utxo-tracker', env: {}, console: sink });
        log.error('DB write failed: SqlError: connect ECONNREFUSED\n  fatal: true,\n  errno: -111');
        expect(sink.lines.error).to.have.lengthOf(1);
        expect(sink.lines.error[0]).to.not.match(/\n/);
        expect(sink.lines.error[0]).to.include('\\n  fatal: true,');
        expect(sink.lines.error[0]).to.match(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z error \[xchain-utxo-tracker\] DB write failed:/);
    });
}

function registerConsoleRecordTests() {
    it('escapes a bare carriage return too, so a progress writer cannot split a record', () => {
        const sink = fakeConsole();
        const log = createLogShipper({ service: 'xchain-utxo-tracker', env: {}, console: sink });
        log.warn('rewriting\rline');
        expect(sink.lines.warn).to.have.lengthOf(1);
        expect(sink.lines.warn[0]).to.include('rewriting\\nline');
    });

    // JSON mode needs no escaping of its own: JSON.stringify already emits one
    // physical line and keeps the true characters, which is better fidelity for a
    // machine reader than a lossy substitution would be.
    it('JSON mode keeps the real newlines and still emits one physical line', () => {
        const sink = fakeConsole();
        const log = createLogShipper({ service: 'xchain-utxo-tracker', env: { LOG_FORMAT: 'json' }, console: sink });
        log.error('line one\nline two');
        expect(sink.lines.error).to.have.lengthOf(1);
        expect(sink.lines.error[0]).to.not.match(/\n/);
        expect(JSON.parse(sink.lines.error[0]).msg).to.equal('line one\nline two');
    });

    it('does not double-format: a shipper built AFTER the patch writes to the pre-patch sink', function () {
        // The shim's default sink is the global console by reference. A shipper
        // taking that default once console is patched emits its formatted line
        // INTO the wrapper and gets it formatted again, so the line reads
        // `<ts> warn [svc] <ts> warn [svc] msg`. Caught by driving the real hub
        // suite, not by reading the diff.
        const seen = [];
        const realWarn = console.warn;
        console.warn = (m) => seen.push(m);
        try {
            patchConsole({ service: 'svc', env: {} });
            // A custom transport means this handle does NOT adopt the process
            // shipper, so it builds a second one: the path where the global
            // console would otherwise be taken as the default sink.
            const second = installObservability(null, { service: 'svc', env: {}, logTransport: () => Promise.resolve() });
            second.logger.warn('once only');
        } finally {
            unpatchConsole();
            console.warn = realWarn;
        }
        expect(seen).to.have.lengthOf(1);
        expect(seen[0]).to.match(/^\S+Z warn \[svc\] once only$/);
    });

    it('hands out one registry, always constructed, before any install call', function () {
        const reg = getRegistry({ service: 'svc' });
        expect(reg).to.equal(getRegistry());
        const c = reg.counter({ name: 'xchain_probe_total', help: 'probe' });
        c.inc({}, 1);
        expect(reg.render()).to.include('xchain_probe_total');
    });
}

module.exports = {
    registerTextFieldFormatTests,
    registerTextFieldSafetyTests,
    registerMessageRedactionTests,
    registerConsoleRoutingTests,
    registerConsoleLifecycleTests,
    registerConsoleRecordTests
};
