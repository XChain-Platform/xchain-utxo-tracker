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

// Regression: a DOGE block whose AuxPoW section skipAuxPow cannot traverse
// used to fail the strip path until the streak was misdiagnosed as a
// pruned-node desync and halted the tracker. After AUXPOW_REASSEMBLE_AFTER
// consecutive failures at one height the loop now rebuilds the pure block
// from getblockheader + verbose getblock + per-txid getrawtransaction,
// never reading the AuxPoW bytes.

const { expect } = require('chai');
const BlockchainConnector = require('../../src/BlockchainConnector');
const { encodeVarintHex } = require('../../src/BlockchainConnector');
const XChainUtxoTracker = require('../../src/XChainUtxoTracker');
const { AUXPOW_REASSEMBLE_AFTER, MAX_BLOCK_FETCH_RETRIES } = require('../../src/XChainUtxoTracker');
const XChainBlockDecoder = require('../../src/XChainBlockDecoder');

// Minimal legacy tx (1 coinbase-style input, 1 empty-script output).
const TX_HEX =
    '01000000' +
    '01' +
    '0000000000000000000000000000000000000000000000000000000000000000' +
    'ffffffff' + '00' + 'ffffffff' +
    '01' + '0100000000000000' + '00' +
    '00000000';
const TXID = 'a'.repeat(64);
// 80-byte header (160 hex chars); content is irrelevant to reassembly.
const HEADER_HEX = '04016200' + '11'.repeat(76);

function makeConnector(overrides) {
    const connector = new BlockchainConnector('127.0.0.1', 0, 'user', 'pass');
    return Object.assign(connector, overrides);
}

describe('malformed-AuxPoW block reassembly fallback', function () {

    it('encodeVarintHex encodes each varint width and refuses >2^32-1', function () {
        expect(encodeVarintHex(0)).to.equal('00');
        expect(encodeVarintHex(0xFC)).to.equal('fc');
        expect(encodeVarintHex(0xFD)).to.equal('fdfd00');
        expect(encodeVarintHex(0xFFFF)).to.equal('fdffff');
        expect(encodeVarintHex(0x10000)).to.equal('fe00000100');
        expect(encodeVarintHex(0xFFFFFFFF)).to.equal('feffffffff');
        expect(() => encodeVarintHex(0x100000000)).to.throw(/out of supported range/);
    });

    describe('BlockchainConnector.getBlockReassembled', function () {
        it('rebuilds header + tx-count varint + raw txs, parseable as a block', async function () {
            const connector = makeConnector({
                getBlockHeader: async () => HEADER_HEX,
                getBlockVerbose: async () => ({ tx: [TXID, TXID] }),
                getRawTransaction: async () => TX_HEX,
            });
            const hex = await connector.getBlockReassembled('hash');
            expect(hex).to.equal(HEADER_HEX + '02' + TX_HEX + TX_HEX);
            const block = new XChainBlockDecoder('dogecoin-mainnet').blockFromHex(hex);
            expect(block.transactions.length).to.equal(2);
        });

        it('uses only the first 80 header bytes when getblockheader appends AuxPoW bytes', async function () {
            const connector = makeConnector({
                getBlockHeader: async () => HEADER_HEX + 'ab'.repeat(40),
                getBlockVerbose: async () => ({ tx: [TXID] }),
                getRawTransaction: async () => TX_HEX,
            });
            expect(await connector.getBlockReassembled('hash')).to.equal(HEADER_HEX + '01' + TX_HEX);
        });

        it('fails loudly when an in-block tx cannot be fetched', async function () {
            const connector = makeConnector({
                getBlockHeader: async () => HEADER_HEX,
                getBlockVerbose: async () => ({ tx: [TXID] }),
                getRawTransaction: async () => null,
            });
            let err = null;
            try { await connector.getBlockReassembled('hash'); } catch (e) { err = e; }
            expect(err).to.be.an('error');
            expect(err.message).to.match(/no raw tx for in-block txid/);
        });
    });

    describe('XChainUtxoTracker.shouldReassembleBlock', function () {
        const call = (ctx, ...args) => XChainUtxoTracker.prototype.shouldReassembleBlock.call(ctx, ...args);

        it('fires only at the threshold, at the same height, on an AuxPoW chain', function () {
            expect(call({ auxPow: true }, 100, 100, AUXPOW_REASSEMBLE_AFTER)).to.equal(true);
            expect(call({ auxPow: true }, 100, 100, AUXPOW_REASSEMBLE_AFTER - 1)).to.equal(false);
            expect(call({ auxPow: true }, 100, 99, AUXPOW_REASSEMBLE_AFTER)).to.equal(false);
            expect(call({ auxPow: false }, 100, 100, AUXPOW_REASSEMBLE_AFTER)).to.equal(false);
        });

        it('threshold sits well below the desync halt bound so the fallback gets attempts in', function () {
            expect(AUXPOW_REASSEMBLE_AFTER).to.be.below(MAX_BLOCK_FETCH_RETRIES);
        });
    });
});
