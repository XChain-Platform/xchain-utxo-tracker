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
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { PassThrough, Writable } = require('stream');
const childProcess = require('child_process');

const COMPRESSION_PATH = require.resolve('../../../src/api/compression.js');

function loadCompression(stub) {
    const realSpawn = childProcess.spawn;
    const cached = require.cache[COMPRESSION_PATH];
    childProcess.spawn = stub;
    delete require.cache[COMPRESSION_PATH];
    try { return require(COMPRESSION_PATH); }
    finally {
        childProcess.spawn = realSpawn;
        delete require.cache[COMPRESSION_PATH];
        if (cached) require.cache[COMPRESSION_PATH] = cached;
    }
}

function fakeChild() {
    const child = new EventEmitter();
    child.stdin = new Writable({ write(chunk, encoding, callback) { callback(); } });
    child.stdout = new PassThrough();
    child.stderr = new EventEmitter();
    return child;
}

function pipelineStub(failing, order) {
    const children = {};
    return (command) => {
        const child = fakeChild();
        children[command] = child;
        if (command === 'du') {
            setImmediate(() => {
                child.stdout.emit('data', Buffer.from('1024\t/data/xchain\n'));
                child.emit('close', 0);
            });
        } else if (command === 'pigz') {
            setImmediate(() => {
                child.stdout.end(Buffer.from('archive bytes'));
                for (const name of order) {
                    if (name === failing) continue;
                    children[name].emit('close', 0);
                }
                setImmediate(() => children[failing].emit('close', 2));
            });
        }
        return child;
    };
}

function successStub(order) {
    const children = {};
    return (command) => {
        const child = fakeChild();
        children[command] = child;
        if (command === 'du') {
            setImmediate(() => {
                child.stdout.emit('data', Buffer.from('1024\t/data/xchain\n'));
                child.emit('close', 0);
            });
        } else if (command === 'pigz') {
            setImmediate(() => {
                child.stdout.end(Buffer.from('complete archive'));
                for (const name of order) children[name].emit('close', 0);
            });
        }
        return child;
    };
}

describe('bootstrap snapshot waits for every pipeline process @regression', function () {
    let dir;
    beforeEach(function () { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-pipeline-')); });
    afterEach(function () { fs.rmSync(dir, { recursive: true, force: true }); });

    for (const failing of ['tar', 'pv']) {
        it(`rejects when ${failing} fails after the compressor and removes the canonical sidecar`, async function () {
            const destination = path.join(dir, 'snapshot.tar.gz');
            fs.writeFileSync(destination + '.sha256', 'stale digest');
            const order = failing === 'tar' ? ['pv', 'pigz'] : ['tar', 'pigz'];
            const { compressDirPigz } = loadCompression(pipelineStub(failing, order));

            let error;
            try { await compressDirPigz(`late-${failing}`, '/data/xchain', destination); }
            catch (err) { error = err; }
            expect(error).to.be.an('error');
            expect(error.message).to.include(failing);
            expect(fs.existsSync(destination + '.sha256')).to.equal(false);
            expect(fs.existsSync(destination + `.sha256.invalid-late-${failing}`)).to.equal(true);
        });
    }

    it('publishes the checksum only after all close events in either order', async function () {
        for (const order of [['tar', 'pv', 'pigz'], ['pigz', 'pv', 'tar']]) {
            const destination = path.join(dir, `snapshot-${order[0]}.tar.gz`);
            const { compressDirPigz } = loadCompression(successStub(order));
            await compressDirPigz(`success-${order[0]}`, '/data/xchain', destination);
            const actual = crypto.createHash('sha256').update(fs.readFileSync(destination)).digest('hex');
            expect(fs.readFileSync(destination + '.sha256', 'utf8')).to.include(actual);
        }
    });
});
