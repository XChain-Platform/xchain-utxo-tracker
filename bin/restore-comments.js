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
 * Put back the comment lines a cleanup pass deleted, at the line they
 * described.
 *
 * WHY THIS IS NOT `git revert`. The commits this recovers from did two things
 * at once: they deleted explanation, and they REWROTE surviving lines to take
 * internal references out. Reverting restores the second along with the first,
 * which puts back exactly the text the publish gate refuses, and it also
 * discards every comment written since. So this works run by run: it takes the
 * runs of comment that the sweep removed and nothing else, drops any line
 * carrying an internal reference, and places each run above the line of CODE it
 * sat above, found in today's file rather than at yesterday's line number.
 *
 * THE ANCHOR IS THE CODE, NOT THE LINE NUMBER. Everything in this repo has
 * moved since the sweep: files renamed, functions hoisted, whole directories
 * re-homed. A run whose anchor line still exists exactly once is placed; a run
 * whose anchor has changed or appears twice is REPORTED and left for a human,
 * because guessing where prose belongs is how a restore pass ends up describing
 * the wrong branch.
 *
 * TWO MODES, because the sweep cost the file two different things:
 *
 *   restore   the DELETED runs, above their anchors.
 *   pairs     the REWRITTEN runs. A run that was replaced rather than removed
 *             is invisible to the first mode: the line count barely moves and
 *             the text is still there, minus the half that carried the
 *             explanation. Pairing is by token-Jaccard over the run, at a 0.3
 *             floor, run to run rather than line to line, because the sweep
 *             also rewrapped and a line-level pairing reads every rewrap as a
 *             total loss.
 *
 * USAGE
 *   node bin/restore-comments.js --sweep <sha> --move-map <file>   report
 *   node bin/restore-comments.js --sweep <sha> --write             place them
 *   node bin/restore-comments.js --sweep <sha> --pairs             pair rewritten runs
 *
 ********************************************************************/

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');

// Text that may never go back into a public repo, whatever the sweep removed
// alongside it. A stanza carrying one of these is refused whole rather than
// restored, and reported, so the summary says how much of the deficit is
// unrecoverable rather than merely un-restored.
//
// The shapes are described rather than spelled out. A tool that lists the
// private names it refuses has published those names, and the publish gate
// reads this file's added lines exactly as it reads any other.
const INTERNAL_REFERENCE = [
    /(?:^|[\s(])#\d{3,5}\b/,              // a review id
    /\/(?:Users|home)\//,                  // an operator's home directory
    /\b[a-z]+\/(?:bin|reports|specs)\//,   // a path into a private tooling tree
];

// A tracker id is letters, a dash and a number, which is also the shape of a
// great deal of public vocabulary: SHA-256, BIP-341, RFC-6979, UTF-8. Those
// name open standards and a comment that cites one is doing its job, so the
// shape counts as a tracker id only when the letters are not a public prefix.
const PUBLIC_PREFIXES = new Set(['SHA', 'BIP', 'RFC', 'UTF', 'ISO', 'AES', 'ECMA', 'EIP', 'SLIP', 'CVE', 'GHSA']);
const TRACKER_ID = /\b([A-Z]{2,4})-\d{2,5}\b/g;

// The vendored trees. The sweep cut comments in four of these files, and those
// lines are the hub's to put back: a consumer that edits its copy creates drift
// that reddens every other consumer's CI, and the sync check here goes red the
// moment it happens. Skipped before anything is read, not filtered afterwards,
// so there is no path through this tool that writes into them.
const FROZEN_PREFIXES = ['src/coins/', 'src/observability/'];

const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/;

function git(args) {
    return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

/** The files a commit touched, old path to new path (a rename gives two). */
function sweepFiles(sha) {
    const out = git(['show', '--name-status', '-M', '--format=', sha]);
    const rows = [];
    for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        const parts = line.split('\t');
        if (parts[0].startsWith('R')) rows.push({ before: parts[1], after: parts[2] });
        else if (parts[0] === 'M' || parts[0] === 'A') rows.push({ before: parts[1], after: parts[1] });
    }
    return rows;
}

/**
 * Where a path from the sweep lives today.
 *
 * A DECLARED map wins, always. The heuristic below reads a basename and guesses,
 * and it guessed wrong for sixteen files in a row here: every suite whose kind
 * extension the rename removed (storage-faults.chaos.js is storage_faults.test.js
 * now, and no amount of case folding gets from one to the other) plus every
 * helper that moved into a support/ directory. Sixteen files skipped in silence
 * is worse than sixteen reported, so the map is passed in and the guess is only
 * the fallback for a file no map mentions.
 */
function currentPath(sweepPath, tracked, moveMap) {
    if (moveMap && moveMap[sweepPath] && tracked.has(moveMap[sweepPath])) return moveMap[sweepPath];
    if (tracked.has(sweepPath)) return sweepPath;
    const base = path.posix.basename(sweepPath);
    const snake = base
        .replace(/^XChain/, 'xchain-')
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
        .replace(/[-.]+/g, '_')
        .toLowerCase()
        .replace(/_(test|fuzz)_js$/, '.$1.js')
        .replace(/_js$/, '.js')
        .replace(/_(chaos|perf)\.(test|fuzz)\.js$/, '.$1.js');
    const hits = Array.from(tracked).filter((f) => {
        const b = path.posix.basename(f);
        return b === base || b === snake
            || b.replace(/[_.-]/g, '') === base.replace(/[_.-]/g, '').toLowerCase()
            || b.replace(/[_.-]/g, '').replace(/(chaos|perf)/, '') === base.replace(/[_.-]/g, '').toLowerCase().replace(/(chaos|perf)/, '');
    });
    return hits.length === 1 ? hits[0] : null;
}

/**
 * Contiguous runs of comment lines in a file's text, with the code line under
 * each. A run is the unit throughout: the sweep removed whole stanzas and
 * rewrote others, and only a stanza has enough context to tell the two apart.
 */
function commentRuns(lines) {
    const runs = [];
    let cur = null;
    for (let i = 0; i < lines.length; i += 1) {
        if (COMMENT_LINE.test(lines[i])) {
            if (!cur) cur = { start: i, lines: [] };
            cur.lines.push(lines[i]);
            continue;
        }
        if (cur) {
            // A blank line between the comment and its code does not break the
            // pairing: plenty of this repo's stanzas are written that way.
            let j = i;
            while (j < lines.length && !lines[j].trim()) j += 1;
            cur.anchor = j < lines.length ? lines[j] : null;
            // The anchor WINDOW, not just the one line under the run. `});` and
            // `}` are the commonest lines in a suite file, so a single-line
            // anchor is ambiguous dozens of times over; three consecutive code
            // lines almost never are. Measured here: single-line anchors left
            // 264 restorable lines unplaced, the window leaves a handful.
            cur.window = [];
            for (let k = j; k < lines.length && cur.window.length < 3; k += 1) {
                if (!lines[k].trim() || COMMENT_LINE.test(lines[k])) continue;
                cur.window.push(lines[k].trim());
            }
            runs.push(cur);
            cur = null;
        }
    }
    if (cur) { cur.anchor = null; runs.push(cur); }
    return runs;
}

/**
 * Can this run stand on its own where it is put back?
 *
 * A line-comment run always can. A run of `*` continuation lines cannot: it is
 * the middle of a block whose opener and closer are elsewhere, and pasting it
 * outside that block is a syntax error, not a comment. So a block run counts
 * only when the sweep took the WHOLE block, opener and closer together.
 */
function isSelfContained(run) {
    const body = run.lines.map((l) => l.trim());
    if (body.every((l) => l.startsWith('//'))) return true;
    return body[0].startsWith('/*') && body[body.length - 1].endsWith('*/');
}

/** The file with every comment and blank line removed: what must not change. */
function codeOnly(text) {
    const out = [];
    let inBlock = false;
    for (const raw of text.split('\n')) {
        let line = raw;
        if (inBlock) {
            const end = line.indexOf('*/');
            if (end === -1) continue;
            line = line.slice(end + 2);
            inBlock = false;
        }
        // Only a comment that OPENS the line is stripped. A trailing // inside a
        // string literal is code, and a stripper that guesses at it would report
        // a difference this tool never made.
        const trimmed = line.trim();
        if (trimmed.startsWith('//')) continue;
        if (trimmed.startsWith('/*')) {
            if (trimmed.includes('*/')) { const after = trimmed.slice(trimmed.indexOf('*/') + 2); if (after.trim()) out.push(after.trim()); continue; }
            inBlock = true;
            continue;
        }
        if (trimmed.startsWith('*') && !trimmed.startsWith('*/')) continue;
        if (!trimmed) continue;
        out.push(trimmed);
    }
    return out.join('\n');
}

function tokens(text) {
    return new Set(String(text).toLowerCase().match(/[a-z0-9_]{3,}/g) || []);
}

function jaccard(a, b) {
    if (!a.size && !b.size) return 1;
    let shared = 0;
    for (const t of a) if (b.has(t)) shared += 1;
    return shared / (a.size + b.size - shared);
}

function carriesInternalReference(line) {
    if (INTERNAL_REFERENCE.some((re) => re.test(line))) return true;
    for (const m of String(line).matchAll(TRACKER_ID)) if (!PUBLIC_PREFIXES.has(m[1])) return true;
    return false;
}

/** Normalised for comparison: leading marker and whitespace do not count. */
function bodyOf(line) {
    return line.replace(/^\s*(?:\/\/+|\*+|\/\*+)\s?/, '').replace(/\*\/\s*$/, '').trim();
}

/**
 * What one file lost, and where it goes back.
 * @returns {{placed: object[], unplaced: object[], dropped: number}}
 */
function analyseFile(sha, before, after, tracked, moveMap) {
    const target = currentPath(after, tracked, moveMap);
    if (!target) return { target: null, placed: [], unplaced: [], dropped: 0 };

    let oldText;
    try { oldText = git(['show', `${sha}^:${before}`]); } catch (e) { return { target, placed: [], unplaced: [], dropped: 0 }; }
    const newText = fs.readFileSync(path.join(REPO_ROOT, target), 'utf8');

    const oldRuns = commentRuns(oldText.split('\n'));
    const nowLines = newText.split('\n');
    const nowRuns = commentRuns(nowLines);
    const nowBodies = new Set();
    for (const r of nowRuns) for (const l of r.lines) nowBodies.add(bodyOf(l));

    const placed = [];
    const unplaced = [];
    let dropped = 0;

    for (const run of oldRuns) {
        const bodies = run.lines.map(bodyOf).filter(Boolean);
        if (!bodies.length) continue;
        // WHOLE runs only. If any line of this stanza survives, the sweep
        // REWROTE it rather than removing it, and re-adding the rest produces a
        // duplicate sentence or a dangling half of one. Those are rewritten
        // runs, found by the pairing pass and merged by a human.
        if (bodies.some((b) => nowBodies.has(b))) continue;
        if (!isSelfContained(run)) {
            unplaced.push({ run: run.lines, why: 'a block-comment fragment: its opener and closer are not in the run' });
            continue;
        }
        const keep = run.lines.filter((l) => !carriesInternalReference(l));
        dropped += run.lines.length - keep.length;
        // Dropping part of a stanza leaves prose that reads as though something
        // is missing, because something is. All or nothing.
        if (keep.length !== run.lines.length) { unplaced.push({ run: run.lines, why: 'part of it carries an internal reference' }); continue; }
        if (!run.anchor || !run.anchor.trim()) { unplaced.push({ run: keep, why: 'the run had no code under it' }); continue; }
        const anchorBody = run.anchor.trim();
        // Widen the window until the match is unique, then fall back to the bare
        // line. A run placed against three lines of code is placed where its
        // prose belongs; one placed against `});` is placed at random.
        let at = [];
        for (let width = Math.min(3, run.window.length); width >= 1; width -= 1) {
            const want = run.window.slice(0, width);
            at = [];
            for (let i = 0; i < nowLines.length; i += 1) {
                if (nowLines[i].trim() !== want[0]) continue;
                let k = i;
                let ok = true;
                for (const w of want) {
                    while (k < nowLines.length && (!nowLines[k].trim() || COMMENT_LINE.test(nowLines[k]))) k += 1;
                    if (k >= nowLines.length || nowLines[k].trim() !== w) { ok = false; break; }
                    k += 1;
                }
                if (ok) at.push(i);
            }
            if (at.length === 1) break;
        }
        if (at.length !== 1) {
            unplaced.push({ run: keep, anchor: anchorBody, why: at.length ? `its anchor window appears ${at.length} times` : 'its anchor line is gone' });
            continue;
        }
        placed.push({ at: at[0], run: keep, anchor: anchorBody });
    }
    return { target, placed, unplaced, dropped };
}

/** Runs that were REPLACED, and whether the replacement kept the prose. */
function pairsForFile(sha, before, after, tracked, moveMap) {
    const target = currentPath(after, tracked, moveMap);
    if (!target) return [];
    let oldText;
    try { oldText = git(['show', `${sha}^:${before}`]); } catch (e) { return []; }
    const oldRuns = commentRuns(oldText.split('\n'));
    const nowRuns = commentRuns(fs.readFileSync(path.join(REPO_ROOT, target), 'utf8').split('\n'));
    const out = [];
    for (const o of oldRuns) {
        const oBody = o.lines.map(bodyOf).join(' ').trim();
        if (!oBody) continue;
        let best = null;
        for (const n of nowRuns) {
            const nBody = n.lines.map(bodyOf).join(' ').trim();
            if (!nBody) continue;
            const score = jaccard(tokens(oBody), tokens(nBody));
            if (!best || score > best.score) best = { score, run: n, body: nBody };
        }
        // 1 means the run survived verbatim; below the floor it is a different
        // run, not a rewrite of this one. Between the two is the rewrite band.
        if (!best || best.score < 0.3 || best.score >= 0.999) continue;
        const lostWords = tokens(oBody).size - tokens(best.body).size;
        if (lostWords <= 0) continue;
        out.push({ file: target, score: Number(best.score.toFixed(2)), lostTokens: lostWords, was: oBody.slice(0, 160), now: best.body.slice(0, 160) });
    }
    return out;
}

function main() {
    const argv = process.argv.slice(2);
    const arg = (n) => { const i = argv.indexOf(n); return i === -1 ? null : argv[i + 1]; };
    const sha = arg('--sweep');
    if (!sha) { console.error('usage: restore-comments.js --sweep <sha> [--file <path>] [--pairs] [--write]'); process.exitCode = 2; return; }
    const only = arg('--file');
    const write = argv.includes('--write');
    const pairs = argv.includes('--pairs');

    const tracked = new Set(git(['ls-files']).split('\n').filter(Boolean));
    const mapArg = arg('--move-map');
    let moveMap = null;
    if (mapArg) {
        const raw = JSON.parse(fs.readFileSync(path.resolve(mapArg), 'utf8'));
        moveMap = raw.moves || raw;
    }
    const isFrozen = (p) => FROZEN_PREFIXES.some((v) => p.startsWith(v));
    const all = sweepFiles(sha);
    const frozen = all.filter((r) => isFrozen(r.after) || isFrozen(r.before));
    for (const r of frozen) console.log(`FROZEN ${r.after}: vendored, its lines are the canonical repo's to restore`);
    const rows = all
        .filter((r) => !isFrozen(r.after) && !isFrozen(r.before))
        .filter((r) => !only || r.after === only || currentPath(r.after, tracked, moveMap) === only);

    if (pairs) {
        let n = 0;
        for (const r of rows) {
            for (const p of pairsForFile(sha, r.before, r.after, tracked, moveMap)) {
                n += 1;
                console.log(`${p.file}  jaccard ${p.score}, ${p.lostTokens} token(s) lost`);
                console.log(`    was: ${p.was}`);
                console.log(`    now: ${p.now}`);
            }
        }
        console.log(`\n${n} rewritten run(s) that lost words, over ${rows.length} swept file(s)`);
        return;
    }

    let files = 0;
    let linesPlaced = 0;
    let linesUnplaced = 0;
    let linesDropped = 0;
    for (const r of rows) {
        const res = analyseFile(sha, r.before, r.after, tracked, moveMap);
        if (!res.target) { console.log(`UNRESOLVED ${r.after}: no single file in the tree matches it`); continue; }
        if (!res.placed.length && !res.unplaced.length) continue;
        files += 1;
        linesDropped += res.dropped;
        for (const u of res.unplaced) {
            linesUnplaced += u.run.length;
            console.log(`UNPLACED ${res.target}: ${u.run.length} line(s), ${u.why}`);
            for (const l of u.run) console.log(`    ${l.trim()}`);
        }
        if (!res.placed.length) continue;
        linesPlaced += res.placed.reduce((a, p) => a + p.run.length, 0);
        if (!write) {
            console.log(`${res.target}: ${res.placed.length} run(s), ${res.placed.reduce((a, p) => a + p.run.length, 0)} line(s) to place back`);
            continue;
        }
        const abs = path.join(REPO_ROOT, res.target);
        const before = fs.readFileSync(abs, 'utf8');
        const lines = before.split('\n');
        // Bottom up, so an earlier insertion does not move a later anchor.
        for (const p of res.placed.slice().sort((a, b) => b.at - a.at)) {
            const indent = (lines[p.at].match(/^\s*/) || [''])[0];
            const text = p.run.map((l) => indent + l.trim());
            lines.splice(p.at, 0, ...text);
        }
        const after = lines.join('\n');
        // The one guarantee a comment restore owes: not one byte of executable
        // code changed. Checked per file, and a file that fails it is left
        // exactly as it was rather than written and apologised for.
        if (codeOnly(before) !== codeOnly(after)) {
            console.log(`REFUSED ${res.target}: the insertion would have changed executable code`);
            linesPlaced -= res.placed.reduce((a, p) => a + p.run.length, 0);
            continue;
        }
        fs.writeFileSync(abs, after);
    }
    console.log(`\n${files} file(s): ${linesPlaced} line(s) ${write ? 'placed' : 'placeable'}, `
        + `${linesUnplaced} unplaced, ${linesDropped} dropped as an internal reference`);
}

if (require.main === module) main();

module.exports = { commentRuns, jaccard, tokens, bodyOf, carriesInternalReference, currentPath, isSelfContained, codeOnly };
