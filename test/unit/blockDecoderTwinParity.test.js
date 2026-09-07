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

// src/XChainBlockDecoder.js is a deliberate twin of the xchain-decoder file at the
// same relative path, and nothing enforced it. The two single-transaction parse
// entry points already diverged in NAME (txFromHex here, transactionFromHex there)
// while their logic stayed aligned, which is the drift this guard exists to catch
// the next time: a one-sided MWEB strip fix would ship silently, and the two
// services would hash and index different bytes for the same Litecoin transaction.
//
// The guard is BEHAVIOURAL, not byte-identity. Byte-identity is what
// auxpowStripParity.test.js can assert about the AuxPoW primitives, because those
// are standalone top-level functions; these are class methods whose names, method
// order and comments legitimately differ per repo. What must agree is the verdict,
// so the vectors below drive both twins over the whole MWEB strip decision matrix
// (tx version x marker x flag) plus a plain non-MWEB parse, and compare results.
//
// The name divergence itself is asserted rather than fixed: each class must expose
// EXACTLY ONE of the two known names, so a third name, or a rename that drops both,
// fails here instead of at a call site.
//
// Skips when the sibling xchain-decoder checkout is absent (standalone deploy),
// matching coins-conformance and auxpowStripParity; set XCHAIN_REQUIRE_SIBLINGS=1
// in CI (with the sibling checked out, or XCHAIN_DECODER_DIR pointed at it) so a
// missing sibling hard-fails instead of green-by-skip.

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const LocalDecoder = require('../../src/XChainBlockDecoder.js');

const DECODER_DIR = process.env.XCHAIN_DECODER_DIR ||
    path.join(__dirname, '..', '..', '..', 'xchain-decoder');
const TWIN_FILE = path.join(DECODER_DIR, 'src', 'XChainBlockDecoder.js');
const TWIN_PRESENT = fs.existsSync(TWIN_FILE);
const REQUIRE_SIBLINGS = process.env.XCHAIN_REQUIRE_SIBLINGS === '1';

// The two known spellings of the single-transaction parse entry point.
const TX_PARSE_NAMES = ['txFromHex', 'transactionFromHex'];

function txParseName(instance, label) {
    const present = TX_PARSE_NAMES.filter(n => typeof instance[n] === 'function');
    expect(present.length,
        `${label} must expose exactly one of ${TX_PARSE_NAMES.join('/')}, found [${present.join(', ')}]`
    ).to.equal(1);
    return present[0];
}

// A minimal well-formed legacy transaction: one input, one P2PKH output. The MWEB
// vectors below splice a marker+flag pair in after the version, which is exactly the
// shape the strip branch is looking for.
const LEGACY_TX_HEX =
    '01000000' +
    '01' + '07'.repeat(32) + '00000000' + '00' + 'ffffffff' +
    '01' + '3930000000000000' + '19' + '76a914' + '11'.repeat(20) + '88ac' +
    '00000000';

// Result of one parse, comparable across repos: the txid on success, or the fact of
// a throw. Not the message: the two repos may legitimately word an error differently,
// and only the verdict is consensus-relevant.
function verdict(instance, method, hex) {
    try {
        return 'txid:' + instance[method](hex).getId();
    } catch (_) {
        return 'throw';
    }
}

describe('XChainBlockDecoder twin parity with xchain-decoder @regression', function () {

    let TwinDecoder = null;

    before(function () {
        if (!TWIN_PRESENT) {
            if (REQUIRE_SIBLINGS)
                throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but the xchain-decoder twin was not found at ' + TWIN_FILE);
            this.skip();
            return;
        }
        TwinDecoder = require(TWIN_FILE);
    });

    it('each twin exposes exactly one tx-parse entry point, from the known pair', function () {
        const local = new LocalDecoder('litecoin-mainnet');
        const twin = new TwinDecoder('litecoin-mainnet');
        expect(txParseName(local, 'xchain-utxo-tracker')).to.equal('txFromHex');
        expect(txParseName(twin, 'xchain-decoder')).to.equal('transactionFromHex');
    });

    it('agrees on the whole MWEB marker/flag strip decision matrix', function () {
        const local = new LocalDecoder('litecoin-mainnet');
        const twin = new TwinDecoder('litecoin-mainnet');
        const localName = txParseName(local, 'xchain-utxo-tracker');
        const twinName = txParseName(twin, 'xchain-decoder');

        // Versions 01/02 are the strip-eligible pair, 03 is not; marker must be 00;
        // flags 08 (MWEB) and 09 (segwit+MWEB) strip, 07 and 00 do not. Every cell is
        // a real parse, so a one-sided change to any arm of that predicate shows up
        // as a different txid or a throw on one side only.
        const cells = [];
        for (const version of ['01000000', '02000000', '03000000'])
            for (const marker of ['00', '01'])
                for (const flag of ['08', '09', '07', '00'])
                    cells.push({ version, marker, flag, hex: version + marker + flag + LEGACY_TX_HEX.slice(8) });

        const mismatches = [];
        let stripped = 0;
        for (const cell of cells) {
            const a = verdict(local, localName, cell.hex);
            const b = verdict(twin, twinName, cell.hex);
            if (a !== b) mismatches.push(`${cell.version}/${cell.marker}/${cell.flag}: tracker ${a} vs decoder ${b}`);
            if (a.startsWith('txid:')) stripped++;
        }
        expect(mismatches, 'MWEB strip verdicts diverged').to.deep.equal([]);
        // Guard the guard: if every cell threw, the comparison above would pass over
        // nothing. Seven cells must parse: versions 01/02 with marker 00 and flag
        // 08/09 (stripped), the three marker-00 flag-00 cells (already legacy), and
        // nothing else. That count moves the moment the strip predicate changes.
        expect(stripped, 'parse-success count moved; the strip predicate changed or the matrix went inert').to.equal(7);
    });

    it('agrees on a plain transaction under the non-MWEB wire formats', function () {
        for (const network of ['bitcoin-mainnet', 'dogecoin-mainnet']) {
            const local = new LocalDecoder(network);
            const twin = new TwinDecoder(network);
            const a = verdict(local, txParseName(local, 'xchain-utxo-tracker'), LEGACY_TX_HEX);
            const b = verdict(twin, txParseName(twin, 'xchain-decoder'), LEGACY_TX_HEX);
            expect(a, network + ' must parse, not throw').to.match(/^txid:/);
            expect(a, network + ' verdicts diverged').to.equal(b);
        }
    });
});
