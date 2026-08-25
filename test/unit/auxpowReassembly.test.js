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

    // Reassembly issues one getrawtransaction per transaction in the block. Aiming
    // that fan-out at a node that is merely unreachable makes an outage worse, so
    // only a tagged AuxPoW-strip fault may feed the streak that triggers it. The
    // decoder twin has counted the two separately since its own escalation misfired
    // on ~15s of node unavailability; the tracker counted every failure alike.
    describe('XChainUtxoTracker.noteAuxPowParseFailure (transport vs content)', function () {
        const note   = (...args) => XChainUtxoTracker.prototype.noteAuxPowParseFailure.call({}, ...args);
        const should = (streak) => XChainUtxoTracker.prototype.shouldReassembleBlock.call(
            { auxPow: true }, 100, streak.height, streak.count);

        function run(height, errors) {
            let streak = { height: null, count: 0 };
            for (const e of errors) streak = note(height, streak.height, streak.count, e);
            return streak;
        }
        const transport = () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        const bare      = () => new Error('There were problems getting a block hex. ');
        const content   = () => Object.assign(new Error('cannot traverse auxpow'), { auxPowParseFailure: true });
        const times     = (n, f) => Array.from({ length: n }, f);

        it('does not escalate on transport faults, however long the streak', function () {
            const n = AUXPOW_REASSEMBLE_AFTER + 3;
            expect(run(100, times(n, transport)).count).to.equal(0);
            expect(should(run(100, times(n, transport)))).to.equal(false);
            expect(should(run(100, times(n, bare)))).to.equal(false);
        });

        it('escalates once the strip itself has failed at the threshold', function () {
            const streak = run(100, times(AUXPOW_REASSEMBLE_AFTER, content));
            expect(streak.count).to.equal(AUXPOW_REASSEMBLE_AFTER);
            expect(should(streak)).to.equal(true);
            expect(should(run(100, times(AUXPOW_REASSEMBLE_AFTER - 1, content)))).to.equal(false);
        });

        it('a transport blip mid-recovery holds the parse streak rather than rewinding it', function () {
            const errors = times(AUXPOW_REASSEMBLE_AFTER - 1, content).concat([transport(), content()]);
            expect(should(run(100, errors))).to.equal(true);
        });

        it('a height change restarts the parse streak', function () {
            let streak = run(100, times(AUXPOW_REASSEMBLE_AFTER, content));
            streak = note(101, streak.height, streak.count, content());
            expect(streak).to.deep.equal({ height: 101, count: 1 });
            streak = note(102, streak.height, streak.count, transport());
            expect(streak).to.deep.equal({ height: 102, count: 0 });
        });
    });

    describe('BlockchainConnector AuxPoW fault tagging', function () {
        // AuxPoW version bit set, 160-char header, and a block body skipAuxPow cannot
        // traverse: the throw comes from the bytes, which is the content fault.
        const UNSTRIPPABLE_BLOCK = HEADER_HEX + 'ff';
        const transport = () => Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });

        it('getBlockWithoutAuxPow rethrows a transport fault untagged, code intact', async function () {
            for (const overrides of [
                { getBlockHeader: async () => { throw transport(); }, getBlock: async () => 'ignored' },
                { getBlockHeader: async () => HEADER_HEX, getBlock: async () => { throw transport(); } },
            ]) {
                let err = null;
                try { await makeConnector(overrides).getBlockWithoutAuxPow('hash'); } catch (e) { err = e; }
                expect(err).to.be.an('error');
                expect(err.code).to.equal('ECONNRESET');
                expect(err.auxPowParseFailure).to.equal(undefined);
            }
        });

        it('getBlockWithoutAuxPow tags a strip fault and keeps the cause', async function () {
            const connector = makeConnector({
                getBlockHeader: async () => HEADER_HEX,
                getBlock: async () => UNSTRIPPABLE_BLOCK,
            });
            let err = null;
            try { await connector.getBlockWithoutAuxPow('hash'); } catch (e) { err = e; }
            expect(err).to.be.an('error');
            expect(err.auxPowParseFailure).to.equal(true);
            expect(err.cause).to.be.an('error');
        });

        it('getBlocksBatchWithoutAuxPow tags a strip fault but not a batch RPC fault', async function () {
            // The prefetch queue is the tracker's normal block source on an AuxPoW
            // chain, so this is where a genuinely malformed block actually fails.
            const batchOk = async (payload) => ({
                data: payload.map((p, i) => ({
                    id: i,
                    result: p.method === 'getblockhash' ? 'h'.repeat(64)
                        : (p.method === 'getblockheader' ? HEADER_HEX : UNSTRIPPABLE_BLOCK)
                }))
            });
            let err = null;
            try {
                await makeConnector({ postWithRetry: batchOk }).getBlocksBatchWithoutAuxPow([100]);
            } catch (e) { err = e; }
            expect(err).to.be.an('error');
            expect(err.auxPowParseFailure).to.equal(true);
            expect(err.message).to.match(/block 100/);

            err = null;
            try {
                await makeConnector({ postWithRetry: async () => { throw transport(); } })
                    .getBlocksBatchWithoutAuxPow([100]);
            } catch (e) { err = e; }
            expect(err).to.be.an('error');
            expect(err.code).to.equal('ECONNRESET');
            expect(err.auxPowParseFailure).to.equal(undefined);
        });
    });
});
