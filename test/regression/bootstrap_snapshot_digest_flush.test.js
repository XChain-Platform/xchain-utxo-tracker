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

// Regression: the .sha256 sidecar must describe the finished archive.
// compressDirPigz must not hash the destination from the pigz child's 'close'
// handler: a child exiting says nothing about the Node write stream having
// flushed, so the sidecar would record the digest of a shorter file than the
// restore path later reads back. The restore path verifies a locally-produced
// snapshot against exactly this sidecar, so a premature digest either fails a
// restore of a good archive or lets a truncated one match its own checksum.
//
// The race is a timing window, so this test opens it deliberately rather than
// hoping to catch it: spawn is stubbed so no tar/pv/pigz binary is needed, and
// the destination write stream is a sink that buffers everything until after
// the pigz child has been reported closed. Without the flush wait the digest
// and the resolve both land while the archive is still empty on disk.

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { Readable, Writable } = require('stream');
const childProcess = require('child_process');
const { expect } = require('chai');

const API_PATH = require.resolve('../../src/api.js');

// api.js destructures `spawn` at require time, so the stub is installed before
// the module loads and the private instance is dropped from the cache after.
function loadApiWithStubbedSpawn(stub) {
    const realSpawn = childProcess.spawn;
    const hadCached = Object.prototype.hasOwnProperty.call(require.cache, API_PATH);
    const cached = require.cache[API_PATH];
    childProcess.spawn = stub;
    delete require.cache[API_PATH];
    try {
        return require(API_PATH);
    } finally {
        childProcess.spawn = realSpawn;
        delete require.cache[API_PATH];
        if (hadCached) require.cache[API_PATH] = cached;
    }
}

function sha256OfFile(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// A destination sink that reproduces the unflushed-writer window: the file
// exists but stays empty until after the child has already been reported closed.
function heldWriteStream(destination, holdMs) {
    const fd = fs.openSync(destination, 'w');
    const held = [];
    return new Writable({
        write(chunk, enc, cb) { held.push(chunk); cb(); },
        final(cb) {
            setTimeout(() => {
                for (const chunk of held) fs.writeSync(fd, chunk);
                fs.closeSync(fd);
                cb();
            }, holdMs);
        },
    });
}

describe('bootstrap snapshot digest describes the flushed archive', function () {

    it('writes the finished file digest, not the digest at pigz exit', async function () {
        const payload = crypto.randomBytes(4 * 1024 * 1024);
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-digest-'));
        const destination = path.join(dir, 'snapshot.tar.gz');

        const stub = (cmd) => {
            const proc = new EventEmitter();
            if (cmd === 'du') {
                proc.stdout = new EventEmitter();
                setImmediate(() => {
                    proc.stdout.emit('data', Buffer.from(`${payload.length}\t/data/xchain\n`));
                    proc.emit('close', 0);
                });
                return proc;
            }
            proc.stdin = new Writable({ write(chunk, enc, cb) { cb(); } });
            proc.stderr = new EventEmitter();
            proc.stdout = new Readable({ read() {} });
            if (cmd === 'pigz') {
                setImmediate(() => {
                    proc.stdout.push(payload);
                    proc.stdout.push(null);
                    proc.emit('close', 0);
                });
            } else {
                setImmediate(() => { proc.stdout.push(null); proc.emit('close', 0); });
            }
            return proc;
        };

        const realCreateWriteStream = fs.createWriteStream;
        fs.createWriteStream = (file, ...rest) => (
            file === destination ? heldWriteStream(destination, 200) : realCreateWriteStream(file, ...rest)
        );

        try {
            const { compressDirPigz } = loadApiWithStubbedSpawn(stub);
            expect(compressDirPigz, 'src/api.js must export compressDirPigz for this guard').to.be.a('function');

            const out = await compressDirPigz('regression-snapshot-digest', '/data/xchain', destination);
            const sidecar = fs.readFileSync(`${out}.sha256`, 'utf8').trim().split(/\s+/)[0];

            expect(fs.statSync(out).size, 'compressDirPigz must not report done while the archive is '
                + 'still buffered: the whole payload has to be on disk by the time it resolves')
                .to.equal(payload.length);
            expect(sidecar, 'the sidecar must record the digest of the finished archive')
                .to.equal(sha256OfFile(out));
        } finally {
            fs.createWriteStream = realCreateWriteStream;
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
