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

// Regression: .env.example is an operator template nothing reads back, so it
// drifts from src/api.js silently and in both directions.
//
//   * It advertised `BULK_SYNC_RAM_BUDGET=4096` under a "Defaults shown"
//     header long after that knob stopped having a flat default: api.js now
//     derives it from the cgroup-aware memory budget. An operator who
//     uncommented the line on a capped container handed the bulk-sync
//     subprocess more memory than the whole cgroup and was OOM-killed at the
//     merge - the exact failure the derivation was added to remove (#5740).
//   * It documented five guards on the serving boundary and omitted three
//     siblings read on the same request path (#5813).
//
// Both are the same cause: nothing compares the template against the code. The
// canonical, gated reference is still
// xchain-documentation/components/utxo-tracker/configuration.md; this guard is
// narrower and local - it only asserts the template cannot LIE about a default
// or omit a knob api.js validates through envInt.

const { expect } = require('chai');
const fs   = require('fs');
const path = require('path');

const API_SRC = fs.readFileSync(path.join(__dirname, '../../src/api.js'), 'utf8');
const ENV_SRC = fs.readFileSync(path.join(__dirname, '../../.env.example'), 'utf8');
const API_LINES = API_SRC.split('\n');

// Every KNOB=value the template advertises, commented out or not. The value is
// kept raw: only a BARE INTEGER is a default claim, everything else (an empty
// value, a path, a placeholder) claims nothing this guard can check.
function advertised() {
    const out = new Map();
    for (const line of ENV_SRC.split('\n')) {
        const m = line.match(/^#?\s*([A-Z][A-Z0-9_]*)\s*=(.*)$/);
        if (m && !out.has(m[1])) out.set(m[1], m[2].trim());
    }
    return out;
}

const isBareInt = (v) => /^\d+$/.test(v);

// The statement in src/api.js that reads process.env.NAME: from the line naming
// it up to the next blank line (capped), so a neighbouring declaration's
// literals can never be mistaken for this knob's default.
function readStatement(name) {
    const at = API_LINES.findIndex((l) => l.includes(`process.env.${name}`));
    if (at < 0) return null;
    const lines = [];
    for (let i = at; i < API_LINES.length && i < at + 6; i++) {
        if (i > at && API_LINES[i].trim() === '') break;
        lines.push(API_LINES[i]);
    }
    return lines.join('\n');
}

// Integer literals sitting in a DEFAULT position within that statement:
// `|| 500`, `, 16)`, `: 10000`. A statement with none supplies no default, so
// its knob is outside this guard rather than silently passing it.
function defaultsIn(stmt) {
    const found = new Set();
    for (const re of [/\|\|\s*(\d+)/g, /,\s*(\d+)\s*\)/g, /:\s*(\d+)\b/g]) {
        let m;
        while ((m = re.exec(stmt)) !== null) found.add(m[1]);
    }
    return found;
}

describe('.env.example does not drift from the defaults src/api.js resolves @regression', function () {

    const ENV = advertised();

    // ── Rule 1: every knob api.js validates through envInt ──────────────────
    // envInt('NAME', <default>, <min>) is the shape every bulk-sync knob uses.
    // The second argument is the authority: a numeric literal is a flat default
    // the template must repeat exactly, and anything else is DERIVED, which the
    // template must not reduce to a number.
    const envIntKnobs = [...API_SRC.matchAll(/envInt\(\s*'([A-Z][A-Z0-9_]*)'\s*,\s*([^,]+?)\s*,/g)]
        .map((m) => ({ name: m[1], dflt: m[2].trim() }));

    it('finds the envInt knobs it is meant to check', function () {
        // Empty-set guard: without this the two assertions below iterate nothing
        // and pass on any refactor that changes api.js' env-resolution shape.
        expect(envIntKnobs.length, 'src/api.js should still resolve its bulk-sync knobs through envInt').to.be.at.least(5);
        const names = envIntKnobs.map((k) => k.name);
        expect(names).to.include('BULK_SYNC_RAM_BUDGET');
        const ram = envIntKnobs.find((k) => k.name === 'BULK_SYNC_RAM_BUDGET');
        expect(isBareInt(ram.dflt), `BULK_SYNC_RAM_BUDGET default is "${ram.dflt}"; a flat literal here would mean the derivation was reverted`).to.equal(false);
    });

    it('advertises every envInt knob, so the template cannot omit a live one', function () {
        for (const { name } of envIntKnobs) {
            expect(ENV.has(name), `${name} is read by src/api.js but appears nowhere in .env.example`).to.equal(true);
        }
    });

    it('repeats a flat default exactly, and advertises no number for a derived one', function () {
        for (const { name, dflt } of envIntKnobs) {
            const shown = ENV.get(name);
            if (isBareInt(dflt)) {
                expect(shown, `.env.example advertises ${name}=${shown} but src/api.js defaults it to ${dflt}`).to.equal(dflt);
            } else {
                expect(isBareInt(shown), `${name} has no flat default in src/api.js (it is ${dflt}), so .env.example must not advertise the bare number ${shown}`).to.equal(false);
            }
        }
    });

    // ── Rule 2: knobs read directly off process.env in api.js ───────────────
    it('advertises the serving-boundary caps the request path actually reads', function () {
        // Named rather than discovered: these three are the ones #5813 found
        // missing while every sibling guard on the same path was documented.
        for (const name of ['UTXO_MAX_RPC_BATCH', 'UTXO_MAX_PAGE_LIMIT', 'UTXO_TRACKER_NODE_RPC_STALE_MS']) {
            expect(readStatement(name), `${name} should still be read by literal name in src/api.js`).to.be.a('string');
            expect(ENV.has(name), `${name} guards the serving boundary but appears nowhere in .env.example`).to.equal(true);
        }
    });

    it('advertises the number src/api.js falls back to, for every checkable knob', function () {
        const checked = [];
        for (const [name, shown] of ENV) {
            if (!isBareInt(shown)) continue;
            const stmt = readStatement(name);
            if (!stmt) continue;                       // resolved outside src/api.js
            const defaults = defaultsIn(stmt);
            if (!defaults.size) continue;              // read with no default at all
            checked.push(name);
            expect([...defaults], `.env.example advertises ${name}=${shown}, which is not the default src/api.js resolves`).to.include(shown);
        }
        // Empty-set guard again: the loop above skips three ways, and every one
        // of them returns the same silent green a real pass returns.
        expect(checked, 'the three serving-boundary caps must actually have been compared').to.include.members([
            'UTXO_MAX_RPC_BATCH', 'UTXO_MAX_PAGE_LIMIT', 'UTXO_TRACKER_NODE_RPC_STALE_MS',
        ]);
    });
});
