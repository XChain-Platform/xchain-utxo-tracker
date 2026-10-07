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

// Pin the bulk-sync dump's AuxPoW recovery: a tagged strip failure is rebuilt
// from RPC parts like the live tracker does, and a transport fault is not.

const crypto = require('crypto');
const { expect } = require('chai');
const { fetchDumpBatch } = require('../../src/bulk_sync/dump');

// Build an 80-byte header for a height and its display-order block hash.
function headerFor(height) {
    const header = Buffer.alloc(80);
    header.writeUInt32LE(height, 0);
    const once = crypto.createHash('sha256').update(header).digest();
    const hash = crypto.createHash('sha256').update(once).digest().reverse().toString('hex');
    return { headerHex: header.toString('hex'), hash };
}

function tagged(message) {
    const err = new Error(message);
    err.auxPowParseFailure = true;
    return err;
}

// Plain-object connector: every height strips cleanly unless listed in badHeights.
function mockConnector({ batchError = null, badHeights = [], perBlockError = null, reassembled = null } = {}) {
    const calls = { batch: 0, plain: 0, strip: [], reassemble: [] };
    const byHash = {};
    const connector = {
        calls,
        async getBlocksBatch(heights) {
            calls.plain++;
            return heights.map((h) => ({ height: h, hash: headerFor(h).hash, hex: 'plain' + h }));
        },
        async getBlocksBatchWithoutAuxPow() {
            calls.batch++;
            throw batchError;
        },
        async getBlockHash(height) {
            const { hash } = headerFor(height);
            byHash[hash] = height;
            return hash;
        },
        async getBlockWithoutAuxPow(hash) {
            calls.strip.push(hash);
            if (perBlockError) throw perBlockError;
            const height = byHash[hash];
            if (badHeights.includes(height)) throw tagged('strip failed at ' + height);
            return headerFor(height).headerHex + '00';
        },
        async getBlockReassembled(hash) {
            calls.reassemble.push(hash);
            if (reassembled) return reassembled;
            return headerFor(byHash[hash]).headerHex + '01ff';
        },
    };
    return connector;
}

describe('bulk-sync dump AuxPoW strip fallback', function () {

    it('reassembles only the block whose strip fails and keeps height order', async function () {
        const connector = mockConnector({ batchError: tagged('batch strip failed'), badHeights: [11] });
        const blocks = await fetchDumpBatch(connector, [10, 11, 12], true);
        expect(blocks.map((b) => b.height)).to.deep.equal([10, 11, 12]);
        expect(connector.calls.reassemble).to.deep.equal([headerFor(11).hash]);
        expect(blocks[1].hex).to.equal(headerFor(11).headerHex + '01ff');
        expect(blocks[0].hex).to.equal(headerFor(10).headerHex + '00');
    });

    it('rethrows an untagged batch error without any per-block refetch', async function () {
        const transport = new Error('ECONNRESET');
        const connector = mockConnector({ batchError: transport });
        let caught = null;
        try { await fetchDumpBatch(connector, [10, 11], true); } catch (err) { caught = err; }
        expect(caught).to.equal(transport);
        expect(connector.calls.strip).to.have.length(0);
        expect(connector.calls.reassemble).to.have.length(0);
    });

    it('rethrows an untagged per-block error without reassembling', async function () {
        const transport = new Error('socket hang up');
        const connector = mockConnector({ batchError: tagged('batch strip failed'), perBlockError: transport });
        let caught = null;
        try { await fetchDumpBatch(connector, [10, 11], true); } catch (err) { caught = err; }
        expect(caught).to.equal(transport);
        expect(connector.calls.reassemble).to.have.length(0);
    });

    it('refuses a reassembled block whose header does not hash to the block hash', async function () {
        const connector = mockConnector({
            batchError: tagged('batch strip failed'),
            badHeights: [11],
            reassembled: headerFor(999).headerHex + '01ff',
        });
        let caught = null;
        try { await fetchDumpBatch(connector, [10, 11], true); } catch (err) { caught = err; }
        expect(caught).to.be.an('error');
        expect(caught.message).to.match(/reassembled block 11 header hashes to/);
    });

    it('passes a non-AuxPoW chain straight through getBlocksBatch', async function () {
        const connector = mockConnector();
        const blocks = await fetchDumpBatch(connector, [5, 6], false);
        expect(connector.calls.plain).to.equal(1);
        expect(connector.calls.batch).to.equal(0);
        expect(blocks.map((b) => b.hex)).to.deep.equal(['plain5', 'plain6']);
    });
});
