#!/usr/bin/env node
/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 **********************************************************************
 *
 * The identity pin: the sha256 of every file this repo carries but does not
 * own, so a restructure can prove it did not touch one.
 *
 * WHAT IS IN IT AND WHY. `src/coins/` and `src/observability/` are vendored in
 * from a canonical elsewhere by a refresh script. This service is a CONSUMER of
 * both: it may read them, it may never edit them, and an edit here is invisible
 * until every other consumer's drift check goes red at once. A rename is as
 * fatal as an edit, so the pin is keyed by path and holds the content hash.
 *
 * WHY NOT JUST RUN THE REFRESH SCRIPT'S CHECK. That check compares this tree
 * against the canonical as it stands TODAY, so it goes green again the moment
 * the canonical moves underneath us, and it cannot answer the question a
 * structure pass actually asks: is this file the same one the pass started
 * with. Two different guards; this is the cheap one, and it needs no sibling
 * checkout present to run.
 *
 * USAGE
 *   node bin/pin-identity.js                     the current hashes, as JSON
 *   node bin/pin-identity.js --out <file>        write them as the pin
 *   node bin/pin-identity.js --compare <file>    diff the tree against a pin,
 *                                                exit 1 on any difference
 *
 ********************************************************************/

'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

// The vendored trees, by the prefix their refresh script owns. Membership is
// read off the tracked tree rather than listed here, so a file the canonical
// adds is pinned by the next run instead of being silently unguarded.
const VENDORED_PREFIXES = ['src/coins/', 'src/observability/'];

/** Tracked files under a vendored prefix, sorted, so two runs agree byte for byte. */
function vendoredFiles() {
    const out = execFileSync('git', ['ls-files', '-z', ...VENDORED_PREFIXES], {
        cwd: REPO_ROOT,
        maxBuffer: 16 * 1024 * 1024,
    });
    return out.toString('utf8').split('\0').filter(Boolean).sort();
}

function sha256(rel) {
    return crypto.createHash('sha256').update(fs.readFileSync(path.join(REPO_ROOT, rel))).digest('hex');
}

/** The pin: one hash per vendored file, plus the tree count each prefix holds. */
function build() {
    const files = {};
    const counts = {};
    for (const rel of vendoredFiles()) {
        files[rel] = sha256(rel);
        const prefix = VENDORED_PREFIXES.find((p) => rel.startsWith(p));
        counts[prefix] = (counts[prefix] || 0) + 1;
    }
    return { vendoredPrefixes: VENDORED_PREFIXES, fileCounts: counts, files };
}

/** Differences against a pin, as human lines. A rename shows as one of each. */
function compare(pin, fresh) {
    const differences = [];
    const names = Array.from(new Set(Object.keys(pin.files).concat(Object.keys(fresh.files)))).sort();
    for (const rel of names) {
        if (!pin.files[rel]) { differences.push(`added   ${rel}`); continue; }
        if (!fresh.files[rel]) { differences.push(`REMOVED ${rel}`); continue; }
        if (pin.files[rel] !== fresh.files[rel]) differences.push(`CHANGED ${rel}`);
    }
    return differences;
}

function main() {
    const argv = process.argv.slice(2);
    const outAt = argv.indexOf('--out');
    const compareAt = argv.indexOf('--compare');
    const fresh = build();

    if (compareAt !== -1) {
        const pin = JSON.parse(fs.readFileSync(path.resolve(argv[compareAt + 1]), 'utf8'));
        const differences = compare(pin, fresh);
        if (!differences.length) {
            console.log(`vendored identity holds: ${Object.keys(fresh.files).length} files unchanged`);
            return;
        }
        console.log(`${differences.length} vendored difference(s):`);
        for (const line of differences) console.log(`  ${line}`);
        process.exitCode = 1;
        return;
    }

    const text = `${JSON.stringify(fresh, null, 2)}\n`;
    if (outAt !== -1) {
        const out = path.resolve(argv[outAt + 1]);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, text);
        console.log(`written to ${path.relative(REPO_ROOT, out)}`);
        return;
    }
    process.stdout.write(text);
}

if (require.main === module) main();

module.exports = { build, compare, vendoredFiles };
