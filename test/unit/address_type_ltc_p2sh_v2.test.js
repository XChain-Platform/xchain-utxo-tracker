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

// Litecoin Core's default test-network P2SH address uses version 0x3a ('Q...').
// One script must carry one type label whichever of its two encodings is queried.

const { expect } = require('chai');
const crypto = require('crypto');
const bitcoin = require('bitcoinjs-lib');
const { createTestTracker, closeTracker } = require('../integration/support/helpers');

const HASH = crypto.createHash('sha1').update('p2sh-v2').digest();
const NETS = {
    rltc: { bech32: 'rltc', scriptHash: 0xc4, pubKeyHash: 0x6f, wif: 0xef, messagePrefix: '', bip32: { public: 0x043587cf, private: 0x04358394 } },
    tltc: { bech32: 'tltc', scriptHash: 0xc4, pubKeyHash: 0x6f, wif: 0xef, messagePrefix: '', bip32: { public: 0x043587cf, private: 0x04358394 } },
    ltc: { bech32: 'ltc', scriptHash: 0x32, pubKeyHash: 0x30, wif: 0xb0, messagePrefix: '', bip32: { public: 0x019da462, private: 0x019d9cfe } },
    doge: { bech32: 'doge', scriptHash: 0x16, pubKeyHash: 0x1e, wif: 0x9e, messagePrefix: '', bip32: { public: 0x02facafd, private: 0x02fac398 } },
};

describe('getAddressType LTC test-network P2SH version 0x3a', function () {
    let tracker;
    beforeEach(async function () { tracker = await createTestTracker(); });
    afterEach(async function () { await closeTracker(tracker); });

    const q = bitcoin.address.toBase58Check(HASH, 0x3a);

    for (const name of ['rltc', 'tltc']) {
        it(`labels the Q form and the 0xc4 form of one hash160 alike on ${name}`, function () {
            const legacy = bitcoin.address.toBase58Check(HASH, 0xc4);
            expect(tracker.getAddressType(legacy, NETS[name])).to.equal('p2sh');
            expect(tracker.getAddressType(q, NETS[name])).to.equal('p2sh');
        });
    }

    it('keeps the 0x3a form unknown on LTC mainnet and DOGE', function () {
        expect(tracker.getAddressType(q, NETS.ltc)).to.equal('unknown');
        expect(tracker.getAddressType(q, NETS.doge)).to.equal('unknown');
    });

    it('keeps other labels unchanged on rltc', function () {
        const p2pkh = bitcoin.address.toBase58Check(HASH, 0x6f);
        const wpkh = bitcoin.address.toBech32(HASH, 0, 'rltc');
        expect(tracker.getAddressType(p2pkh, NETS.rltc)).to.equal('p2pkh');
        expect(tracker.getAddressType(wpkh, NETS.rltc)).to.equal('p2wpkh');
        expect(tracker.getAddressType('notanaddress', NETS.rltc)).to.equal('unknown');
    });
});
