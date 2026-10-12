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

// src/chain/XChainBlockDecoder.js is a deliberate twin of the xchain-decoder file at the
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
// The block-level MWEB path is compared the same way. It is laid out differently in
// the two repos (named helpers here, one inlined reader there), so byte-identity
// cannot guard it, and it holds the rules that decide which txs a service sees: the
// remaining/10 tx-count bound, the HogEx strip on the LAST tx only, the 80-byte
// header-only return and the witness-commit copy.
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

const LocalDecoder = require('../../src/chain/XChainBlockDecoder.js');

const DECODER_DIR = process.env.XCHAIN_DECODER_DIR ||
    path.join(__dirname, '../../../xchain-decoder');
const TWIN_FILE = path.join(DECODER_DIR, 'src', 'chain', 'XChainBlockDecoder.js');
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

let TwinDecoder = null;

function loadTwinDecoder() {
    if (!TWIN_PRESENT) {
        if (REQUIRE_SIBLINGS)
            throw new Error('XCHAIN_REQUIRE_SIBLINGS=1 but the xchain-decoder twin was not found at ' + TWIN_FILE);
        this.skip();
        return;
    }
    if (TwinDecoder === null) TwinDecoder = require(TWIN_FILE);
}

describe('XChainBlockDecoder twin parity with xchain-decoder @regression', function () {
    before(loadTwinDecoder);

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
});

describe('XChainBlockDecoder twin parity with xchain-decoder @regression', function () {
    before(loadTwinDecoder);

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

// Result of one block parse, comparable across repos: block id, txid list (null for a
// header-only block) and witness-commit hex, or the fact of a throw. A fresh Buffer per
// call, so one side can never see bytes the other side's strip rewrote.
function blockVerdict(instance, hex) {
    try {
        const block = instance.blockFromBuffer(Buffer.from(hex, 'hex'));
        return JSON.stringify({
            id: block.getId(),
            txids: block.transactions === undefined ? null : block.transactions.map(t => t.getId()),
            witnessCommit: block.witnessCommit ? block.witnessCommit.toString('hex') : null,
        });
    } catch (_) {
        return 'throw';
    }
}

// An 80-byte header: version 1 and a fixed timestamp, everything else zero.
const HEADER_HEX = (() => {
    const header = Buffer.alloc(80);
    header.writeInt32LE(1, 0);
    header.writeUInt32LE(1700000000, 68);
    return header.toString('hex');
})();

// The legacy tx with a marker+flag spliced in after the version: a HogEx-shaped tx.
const hogexTx = (flag, version = '01000000') => version + '00' + flag + LEGACY_TX_HEX.slice(8);

// The smallest tx the count bound admits: version, 0 inputs, 0 outputs, locktime.
const MIN_TX_HEX = '01000000' + '00' + '00' + '00000000';

// A segwit coinbase whose second output is a witness commitment of 0xab x 32.
const SEGWIT_COINBASE_HEX =
    '01000000' + '0001' +
    '01' + '00'.repeat(32) + 'ffffffff' + '04' + '01020304' + 'ffffffff' +
    '02' + '0100000000000000' + '01' + '51' +
    '0000000000000000' + '26' + '6a24aa21a9ed' + 'ab'.repeat(32) +
    '01' + '20' + '00'.repeat(32) +
    '00000000';

// Each vector pins the TRACKER outcome as well (throw, txs: null for header-only, or a
// tx count), so the cross-repo comparison cannot pass because every vector threw.
const BLOCK_VECTORS = [
    { name: 'header only, exactly 80 bytes', hex: HEADER_HEX, expect: { txs: null } },
    { name: 'buffer under 80 bytes', hex: HEADER_HEX.slice(0, 80), expect: 'throw' },
    { name: 'zero transactions', hex: HEADER_HEX + '00', expect: { txs: 0 } },
    { name: 'one plain tx', hex: HEADER_HEX + '01' + LEGACY_TX_HEX, expect: { txs: 1 } },
    { name: 'HogEx last, flag 08', hex: HEADER_HEX + '01' + hogexTx('08'), expect: { txs: 1 } },
    { name: 'HogEx last, flag 09', hex: HEADER_HEX + '01' + hogexTx('09'), expect: { txs: 1 } },
    { name: 'plain tx then HogEx last', hex: HEADER_HEX + '02' + LEGACY_TX_HEX + hogexTx('08'), expect: { txs: 2 } },
    { name: 'HogEx-shaped FIRST tx is not stripped', hex: HEADER_HEX + '02' + hogexTx('08') + LEGACY_TX_HEX, expect: 'throw' },
    { name: 'version 03 HogEx shape is not stripped', hex: HEADER_HEX + '01' + hogexTx('08', '03000000'), expect: 'throw' },
    { name: 'forged tx count', hex: HEADER_HEX + 'c8' + LEGACY_TX_HEX, expect: 'throw' },
    { name: 'count bound: N txs in exactly 10*N bytes', hex: HEADER_HEX + '03' + MIN_TX_HEX.repeat(3), expect: { txs: 3 } },
    { name: 'count bound: N+1 claimed in 10*N bytes', hex: HEADER_HEX + '04' + MIN_TX_HEX.repeat(3), expect: 'throw' },
    { name: 'truncated tx body', hex: HEADER_HEX + '01' + LEGACY_TX_HEX.slice(0, LEGACY_TX_HEX.length / 2), expect: 'throw' },
    { name: 'witness commitment', hex: HEADER_HEX + '01' + SEGWIT_COINBASE_HEX, expect: { txs: 1, witnessCommit: 'ab'.repeat(32) } },
];

// Check one tracker verdict against its pinned kind; returns a message or null.
function pinnedMismatch(vector, got) {
    if (vector.expect === 'throw') return got === 'throw' ? null : 'expected a throw, got ' + got;
    if (got === 'throw') return 'expected a parse, got a throw';
    const parsed = JSON.parse(got);
    const count = parsed.txids === null ? null : parsed.txids.length;
    if (count !== vector.expect.txs) return 'expected ' + vector.expect.txs + ' txs, got ' + count;
    const commit = vector.expect.witnessCommit || null;
    if (parsed.witnessCommit !== commit) return 'expected witnessCommit ' + commit + ', got ' + parsed.witnessCommit;
    return null;
}

describe('XChainBlockDecoder twin parity with xchain-decoder @regression', function () {
    before(loadTwinDecoder);

    it('agrees on the block-level MWEB path: count bound, strip-last-only, header-only, witness commit', function () {
        const local = new LocalDecoder('litecoin-mainnet');
        const twin = new TwinDecoder('litecoin-mainnet');
        const mismatches = [];
        const pinned = [];
        for (const vector of BLOCK_VECTORS) {
            const a = blockVerdict(local, vector.hex);
            const b = blockVerdict(twin, vector.hex);
            if (a !== b) mismatches.push(`${vector.name}: tracker ${a} vs decoder ${b}`);
            const off = pinnedMismatch(vector, a);
            if (off) pinned.push(`${vector.name}: ${off}`);
        }
        expect(mismatches, 'MWEB block verdicts diverged').to.deep.equal([]);
        // Guard the guard: a change made to both twins at once moves these pins.
        expect(pinned, 'tracker block outcomes moved off their pinned kinds').to.deep.equal([]);
    });

    it('strips the HogEx marker+flag so the last tx hashes as its plain form', function () {
        const plainTxid = new LocalDecoder('litecoin-mainnet').txFromHex(LEGACY_TX_HEX).getId();
        for (const flag of ['08', '09']) {
            const hex = HEADER_HEX + '01' + hogexTx(flag);
            const a = JSON.parse(blockVerdict(new LocalDecoder('litecoin-mainnet'), hex));
            const b = JSON.parse(blockVerdict(new TwinDecoder('litecoin-mainnet'), hex));
            expect(a.txids, 'tracker flag ' + flag).to.deep.equal([plainTxid]);
            expect(b.txids, 'decoder flag ' + flag).to.deep.equal([plainTxid]);
        }
    });

    it('agrees on a plain block under the non-MWEB wire formats', function () {
        const hex = HEADER_HEX + '01' + LEGACY_TX_HEX;
        for (const network of ['bitcoin-mainnet', 'dogecoin-mainnet']) {
            const a = blockVerdict(new LocalDecoder(network), hex);
            const b = blockVerdict(new TwinDecoder(network), hex);
            expect(a, network + ' must parse, not throw').to.not.equal('throw');
            expect(a, network + ' block verdicts diverged').to.equal(b);
        }
    });
});
