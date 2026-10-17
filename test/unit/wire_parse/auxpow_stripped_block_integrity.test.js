// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

// A wrong AuxPoW cut must never reach the block decoder as a block. Dogecoin
// mainnet block 4500000 is rebuilt byte-exact from real chain data
// (test/fixtures/wire_parse_vectors.json), then single-byte changes are made in
// its AuxPoW section. Each one moves skipAuxPow's cut, and bitcoinjs
// Block.fromBuffer checks neither the merkle root nor trailing bytes, so the
// stripped hex can read as a block holding zero transactions. The strip must
// refuse every such result inside the AuxPoW try, where the refusal is tagged
// auxPowParseFailure and fetchBlockHex can escalate to per-tx reassembly.
// The plain path (no AuxPoW strip) gets the same three checks in blockFromBuffer.

const assert = require('assert')
const crypto = require('crypto')
const bitcoinjs = require('bitcoinjs-lib')
const BlockchainConnector = require('../../../src/chain/blockchain_connector')
const { stripAuxPowFromBlockHex } = require('../../../src/chain/blockchain_connector/auxpow_codec.js')
const XChainBlockDecoder = require('../../../src/chain/XChainBlockDecoder')
const VECTORS = require('../../fixtures/wire_parse_vectors.json')

const DOGE = VECTORS.doge4500000
const BODY = '03' + DOGE.txs.join('')
const NODE_BLOCK = DOGE.header + DOGE.auxpow + BODY
const PURE_BLOCK = DOGE.header + BODY

const AUX = Buffer.from(DOGE.auxpow, 'hex')
const COINBASE_LENGTH = bitcoinjs.Transaction.fromBuffer(AUX, true).byteLength()
const CB_BRANCH_COUNT_AT = COINBASE_LENGTH + 32
const CHAIN_BRANCH_COUNT_AT = CB_BRANCH_COUNT_AT + 1 + AUX[CB_BRANCH_COUNT_AT] * 32 + 4

function withAuxByte(offset, value) {
    const aux = Buffer.from(AUX)
    aux[offset] = value
    return DOGE.header + aux.toString('hex') + BODY
}

// Every entry is a node answer whose AuxPoW cut lands off the real boundary while
// skipAuxPow still traverses it; the strip refuses each one.
const MALFORMED = {
    'chain branch count raised by one': withAuxByte(CHAIN_BRANCH_COUNT_AT, AUX[CHAIN_BRANCH_COUNT_AT] + 1),
    'chain branch count lowered by one': withAuxByte(CHAIN_BRANCH_COUNT_AT, AUX[CHAIN_BRANCH_COUNT_AT] - 1),
    'coinbase branch count raised by one': withAuxByte(CB_BRANCH_COUNT_AT, AUX[CB_BRANCH_COUNT_AT] + 1),
    'one zero byte after the AuxPoW section': DOGE.header + DOGE.auxpow + '00' + BODY,
    'eight zero bytes after the AuxPoW section': DOGE.header + DOGE.auxpow + '00'.repeat(8) + BODY,
    'AuxPoW section with nothing after it': DOGE.header + DOGE.auxpow,
    'parent header dropped': DOGE.header + DOGE.auxpow.slice(0, -160) + BODY,
}

function connectorServing(blockHex, headerHex) {
    const connector = new BlockchainConnector('127.0.0.1', 0, 'user', 'pass')
    connector.getBlockHeader = async () => headerHex
    connector.getBlock = async () => blockHex
    // The batch path posts JSON-RPC arrays; answer each call from the same node view.
    connector.postWithRetry = async (data) => {
        const answer = (q) => ({ id: q.id, error: null,
            result: { getblockhash: DOGE.hash, getblockheader: headerHex, getblock: blockHex }[q.method] })
        return { data: Array.isArray(data) ? data.map(answer) : answer(data) }
    }
    return connector
}

describe('AuxPoW stripped-block integrity @regression', function () {
    describe('a real merge-mined block [REGRESSION P1]', function () {
        it('the fixture header hashes to the real block hash', function () {
            const hash = crypto.createHash('sha256').update(crypto.createHash('sha256')
                .update(Buffer.from(DOGE.header, 'hex')).digest()).digest().reverse().toString('hex')
            assert.strictEqual(hash, DOGE.hash)
        })

        it('strips to the pure block when getblockheader returns the 80-byte header', function () {
            assert.strictEqual(stripAuxPowFromBlockHex(DOGE.header, NODE_BLOCK), PURE_BLOCK)
        })

        it('strips to the pure block when getblockheader carries the AuxPoW bytes', function () {
            assert.strictEqual(stripAuxPowFromBlockHex(DOGE.header + DOGE.auxpow, NODE_BLOCK), PURE_BLOCK)
        })

        it('the batch path strips to the same pure block', async function () {
            const [fetched] = await connectorServing(NODE_BLOCK, DOGE.header).getBlocksBatchWithoutAuxPow([4500000])
            assert.strictEqual(fetched.hex, PURE_BLOCK)
        })

        it('decodes the stripped block to the real txids', function () {
            const block = new XChainBlockDecoder('dogecoin-mainnet').blockFromHex(PURE_BLOCK)
            assert.deepStrictEqual(block.transactions.map(t => t.getId()), DOGE.txids)
        })
    })
})

describe('AuxPoW stripped-block integrity @regression', function () {
    describe('a malformed AuxPoW section is refused, never a block [REGRESSION P1]', function () {
        for (const [name, hex] of Object.entries(MALFORMED)) {
            it(`${name}: the strip throws instead of returning a block`, function () {
                assert.throws(() => stripAuxPowFromBlockHex(DOGE.header, hex), /AuxPoW parse:/)
            })

            it(`${name}: getBlockWithoutAuxPow rejects tagged auxPowParseFailure`, async function () {
                await assert.rejects(() => connectorServing(hex, DOGE.header).getBlockWithoutAuxPow(DOGE.hash),
                    err => err.auxPowParseFailure === true)
            })

            it(`${name}: getBlocksBatchWithoutAuxPow rejects tagged auxPowParseFailure`, async function () {
                await assert.rejects(() => connectorServing(hex, DOGE.header).getBlocksBatchWithoutAuxPow([4500000]),
                    err => err.auxPowParseFailure === true)
            })
        }

        it('the legacy long-header path refuses a cut that leaves trailing bytes', function () {
            // An older daemon's header that is one byte short of the real AuxPoW size
            // makes the length-delta cut land one byte early.
            const shortHeader = DOGE.header + DOGE.auxpow.slice(0, -2)
            assert.throws(() => stripAuxPowFromBlockHex(shortHeader, NODE_BLOCK), /AuxPoW parse:/)
        })
    })
})

describe('AuxPoW stripped-block integrity @regression', function () {
    describe('the plain path checks the same three things [REGRESSION P1]', function () {
        const decoders = ['dogecoin-mainnet', 'bitcoin-mainnet', 'litecoin-mainnet']
        for (const network of decoders) {
            it(`${network}: refuses a tx count of zero with transactions trailing`, function () {
                const hex = DOGE.header + '00' + DOGE.txs.join('')
                assert.throws(() => new XChainBlockDecoder(network).blockFromHex(hex), /no transactions/)
            })

            it(`${network}: refuses a merkle root that does not match the transactions`, function () {
                const hex = DOGE.header + '02' + DOGE.txs.slice(0, 2).join('')
                assert.throws(() => new XChainBlockDecoder(network).blockFromHex(hex), /merkle root/)
            })

            it(`${network}: accepts the real body and keeps the 80-byte header-only parse`, function () {
                const decoder = new XChainBlockDecoder(network)
                assert.deepStrictEqual(decoder.blockFromHex(PURE_BLOCK).transactions.map(t => t.getId()), DOGE.txids)
                assert.strictEqual(decoder.blockFromHex(DOGE.header).transactions, undefined)
            })
        }

        for (const network of ['dogecoin-mainnet', 'bitcoin-mainnet']) {
            it(`${network}: refuses bytes after the last transaction`, function () {
                assert.throws(() => new XChainBlockDecoder(network).blockFromHex(PURE_BLOCK + '00'),
                    /after its last transaction/)
            })
        }
    })
})
