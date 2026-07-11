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

// ─── Regression: bulk-sync resume artifact validation ────────────────────────
//
// The orchestrator's resume gates were existence-only (concat) and size-only
// (sorted intermediates), so a merge dir reused across runs could silently
// feed a stale artifact from a DIFFERENT range/network into the pipeline.
// merger/resume-manifest.js closes both: concat artifacts are validated
// against their own self-describing 64B header, and headerless sorted
// artifacts are bound to their source header via an atomic JSON sidecar.

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { expect } = require('chai');

const { OutputsWriter } = require('../../src/bulk-sync/writers.js');
const { concatFilesWithHeader } = require('../../src/bulk-sync/orchestrator.js');
const {
    parseDatHeader, networkToCodes, validateConcatArtifact,
    writeSortedManifest, checkSortedManifest, manifestPath,
} = require('../../src/bulk-sync/merger/resume-manifest.js');

const HEADER_SIZE = 64;

function fullTxid(ch) { return Buffer.from(ch.repeat(64), 'hex'); }

// Build a real per-worker outputs file, then concat it (patching the header
// count) so the artifact matches what phaseMerge actually reuses.
function buildConcatOutputs(tmp, { chain = 'bitcoin', net = 'regtest', from = 100, to = 102, name = 'all-outputs.dat' } = {}) {
    const workerPath = path.join(tmp, `outputs-${from}-${to}.dat`);
    const w = new OutputsWriter(workerPath, chain, net, from, to);
    const script = Buffer.alloc(32, 0xaa);
    for (let h = from; h <= to; h++) {
        const txid = fullTxid((0x10 + h % 200).toString(16).padStart(2, '0'));
        w.append(txid.subarray(0, 8), 0, 5000000000n, h, txid, script, Buffer.alloc(32, h & 0xff), false);
    }
    w.close();
    const outPath = path.join(tmp, name);
    concatFilesWithHeader([workerPath], outPath, HEADER_SIZE);
    return outPath;
}

describe('Regression (bulk-sync): resume artifact validation', function () {
    this.timeout(20000);

    let tmp;
    beforeEach(function () { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-bulk-manifest-')); });
    afterEach(function () { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} });

    describe('networkToCodes', function () {
        it('maps orchestrator network strings to header codes', function () {
            expect(networkToCodes('bitcoin-regtest')).to.deep.equal({ chain: 1, net: 3 });
            expect(networkToCodes('dogecoin-mainnet')).to.deep.equal({ chain: 3, net: 1 });
        });
        it('fails loud on unknown chain or net', function () {
            expect(() => networkToCodes('solana-mainnet')).to.throw(/Unknown chain/);
            expect(() => networkToCodes('bitcoin-stagenet')).to.throw(/Unknown net/);
        });
    });

    describe('validateConcatArtifact (self-describing header gate)', function () {
        it('accepts an artifact whose header matches the run identity', function () {
            const p = buildConcatOutputs(tmp, { from: 100, to: 102 });
            const res = validateConcatArtifact(p, { ...networkToCodes('bitcoin-regtest'), from: 100, to: 102 });
            expect(res.ok, res.reason).to.equal(true);
            expect(res.header.firstHeight).to.equal(100);
            expect(res.header.lastHeight).to.equal(102);
        });

        it('rejects a stale artifact from a different range (the resume window)', function () {
            const p = buildConcatOutputs(tmp, { from: 100, to: 102 });
            const wrongFrom = validateConcatArtifact(p, { ...networkToCodes('bitcoin-regtest'), from: 200, to: 202 });
            expect(wrongFrom.ok).to.equal(false);
            expect(wrongFrom.reason).to.include('firstHeight');
        });

        it('rejects an artifact from a different chain or network', function () {
            const p = buildConcatOutputs(tmp, { chain: 'litecoin', net: 'testnet', from: 100, to: 102 });
            const res = validateConcatArtifact(p, { ...networkToCodes('bitcoin-regtest'), from: 100, to: 102 });
            expect(res.ok).to.equal(false);
            expect(res.reason).to.include('chain/net');
        });

        it('tip mode (to=null) checks only the start height', function () {
            const p = buildConcatOutputs(tmp, { from: 100, to: 102 });
            const res = validateConcatArtifact(p, { ...networkToCodes('bitcoin-regtest'), from: 100, to: null });
            expect(res.ok, res.reason).to.equal(true);
        });

        it('rejects a truncated artifact (body != recordCount x recordSize)', function () {
            const p = buildConcatOutputs(tmp, { from: 100, to: 102 });
            fs.truncateSync(p, fs.statSync(p).size - 10);
            const res = validateConcatArtifact(p, { ...networkToCodes('bitcoin-regtest'), from: 100, to: 102 });
            expect(res.ok).to.equal(false);
            expect(res.reason).to.include('recordCount');
        });

        it('rejects a foreign file with an unknown magic', function () {
            const p = path.join(tmp, 'all-outputs.dat');
            fs.writeFileSync(p, Buffer.alloc(HEADER_SIZE + 121));
            const res = validateConcatArtifact(p, { ...networkToCodes('bitcoin-regtest'), from: 100, to: 102 });
            expect(res.ok).to.equal(false);
            expect(res.reason).to.include('magic');
        });
    });

    describe('sorted-artifact sidecar manifest', function () {
        function setup() {
            const srcPath = buildConcatOutputs(tmp, { from: 100, to: 102 });
            const header  = parseDatHeader(srcPath);
            const sortedPath = path.join(tmp, 'outputs-sorted.dat');
            // The "sorted" body: source minus header (content irrelevant here;
            // the gate binds identity + size, ordering is externalSort's job).
            const body = fs.readFileSync(srcPath).subarray(HEADER_SIZE);
            fs.writeFileSync(sortedPath, body);
            return { srcPath, header, sortedPath };
        }

        it('round-trips: a manifest written after a sort validates against the same source', function () {
            const { header, sortedPath } = setup();
            writeSortedManifest(sortedPath, header);
            const res = checkSortedManifest(sortedPath, header);
            expect(res.ok, res.reason).to.equal(true);
        });

        it('refuses reuse when no manifest exists (pre-manifest or foreign artifact)', function () {
            const { header, sortedPath } = setup();
            const res = checkSortedManifest(sortedPath, header);
            expect(res.ok).to.equal(false);
            expect(res.reason).to.include('no resume manifest');
        });

        it('refuses reuse when the source header changed (same-size stale artifact)', function () {
            const { header, sortedPath } = setup();
            writeSortedManifest(sortedPath, header);
            // A different run over an equally-sized input: same byte count,
            // different range. Size-only gating reused this; the manifest must not.
            const otherSrc = buildConcatOutputs(tmp, { from: 200, to: 202, name: 'all-outputs-2.dat' });
            const otherHeader = parseDatHeader(otherSrc);
            expect(otherHeader.fileSize).to.equal(header.fileSize);
            const res = checkSortedManifest(sortedPath, otherHeader);
            expect(res.ok).to.equal(false);
            expect(res.reason).to.include('firstHeight');
        });

        it('refuses reuse when the sorted artifact size drifted from the manifest', function () {
            const { header, sortedPath } = setup();
            writeSortedManifest(sortedPath, header);
            fs.appendFileSync(sortedPath, Buffer.alloc(1));
            const res = checkSortedManifest(sortedPath, header);
            expect(res.ok).to.equal(false);
            expect(res.reason).to.include('sortedSize');
        });

        it('refuses reuse on an unreadable manifest instead of throwing', function () {
            const { header, sortedPath } = setup();
            fs.writeFileSync(manifestPath(sortedPath), '{not json');
            const res = checkSortedManifest(sortedPath, header);
            expect(res.ok).to.equal(false);
            expect(res.reason).to.include('unreadable');
        });

        it('writes the manifest atomically (no .tmp left behind)', function () {
            const { header, sortedPath } = setup();
            writeSortedManifest(sortedPath, header);
            expect(fs.existsSync(manifestPath(sortedPath) + '.tmp')).to.equal(false);
            expect(fs.existsSync(manifestPath(sortedPath))).to.equal(true);
        });
    });
});
