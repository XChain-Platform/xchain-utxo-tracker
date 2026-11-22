'use strict';

// Copyright © 2025-2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC - https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// Bitcoin Core names a pay-to-anchor output (script 51024e73) with a bech32m
// address. The address read path must resolve it to that script, so an indexed
// P2A output is reachable by address, while near-miss addresses stay client errors.

const { expect } = require('chai');
const crypto = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const { bech32m } = require('bech32');
const { createTestTracker, closeTracker } = require('../integration/support/helpers');

const P2A_REGTEST = 'bcrt1pfeesnyr2tx';
const P2A_MAINNET = 'bc1pfeessrawgf';
const P2A_HASH = crypto.createHash('sha256').update(Buffer.from('51024e73', 'hex')).digest('hex');

function v1Address(prefix, bytes) {
    return bech32m.encode(prefix, [1, ...bech32m.toWords(Buffer.from(bytes))]);
}

describe('address_queries pay-to-anchor addresses', function () {
    let tracker;
    beforeEach(async function () { tracker = await createTestTracker(); });
    afterEach(async function () { await closeTracker(tracker); });

    it('decodes the regtest P2A address to the 51024e73 script', async function () {
        let seen = null;
        tracker.db.getOutputScriptBlock = async (h) => { seen = h; return { h: 7 }; };
        const res = await tracker.getFirstSeen(P2A_REGTEST);
        expect(res).to.deep.equal({ height: 7 });
        expect(seen).to.equal(P2A_HASH);
    });

    it('getUtxosAddress queries the output index by the P2A script hash', async function () {
        const hashes = [];
        const real = tracker.db.getOutputsScriptPubKey.bind(tracker.db);
        tracker.db.getOutputsScriptPubKey = async (h, o) => { hashes.push(h); return real(h, o); };
        const res = await tracker.getUtxosAddress(P2A_REGTEST);
        expect(res).to.exist;
        expect(hashes).to.include(P2A_HASH);
    });

    it('still decodes a witness v1 address with a 32-byte program as p2tr', async function () {
        const addr = v1Address('bcrt', Buffer.alloc(32, 7));
        const expected = bitcoin.address.toOutputScript(addr, tracker.network);
        let seen = null;
        tracker.db.getOutputScriptBlock = async (h) => { seen = h; return null; };
        await tracker.getFirstSeen(addr);
        expect(seen).to.equal(crypto.createHash('sha256').update(expected).digest('hex'));
    });

    const rejected = [
        ['the mainnet P2A address on regtest', P2A_MAINNET],
        ['another 2-byte v1 program', v1Address('bcrt', [0x61, 0x61])],
        ['a bad checksum', P2A_REGTEST.slice(0, -1) + 'y'],
    ];
    rejected.forEach(([label, addr]) => {
        it(`rejects ${label} as BAD_REQUEST`, async function () {
            let err = null;
            try { await tracker.getFirstSeen(addr); } catch (e) { err = e; }
            expect(err, 'expected a throw').to.be.an('error');
            expect(err.code).to.equal('BAD_REQUEST');
        });
    });
});
