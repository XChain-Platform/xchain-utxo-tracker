'use strict'

// Copyright © 2025–2026 Dankest, LLC
// Based on XChain Platform by Dankest, LLC – https://dankest.llc
//
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// This file is part of XChain Platform. Licensed under the GNU Affero
// General Public License v3.0 or later; see LICENSE.md. A commercial
// license (without AGPL source-disclosure terms) is available -
// contact legal@dankest.llc.

const { expect } = require('chai')
const {
    defaultArgs,
    effectiveTipSafety,
    isMainnetNetwork,
    resolveVerifyDefaults,
} = require('../../../../src/bulk_sync/orchestrator/cli_options.js')

function testDefaultArgs() {
    it('returns the complete command-line defaults', function () {
        expect(defaultArgs()).to.deep.equal({
            network: null,
            from: 0,
            to: null,
            tipSafety: 10,
            allowUndoWindow: false,
            chunkSize: 10000,
            out: null,
            db: null,
            workers: null,
            ramBudget: 1024,
            batchSize: 10000,
            cleanupThresholdMb: 100 * 1024,
            skipDump: false,
            verifyChain: null,
            verifyMerkle: null,
            skipParse: false,
            removeSpent: true,
        })
    })
}

function testNetworkDetection() {
    it('recognizes only networks with the mainnet suffix', function () {
        expect(isMainnetNetwork('bitcoin-mainnet')).to.equal(true)
        expect(isMainnetNetwork('bitcoin-testnet')).to.equal(false)
        expect(isMainnetNetwork('bitcoin-regtest')).to.equal(false)
        expect(isMainnetNetwork(null)).to.equal(false)
    })
}

function testVerificationDefaults() {
    it('enables verification defaults on mainnet', function () {
        const args = defaultArgs()
        args.network = 'bitcoin-mainnet'

        expect(resolveVerifyDefaults(args)).to.equal(args)
        expect(args.verifyChain).to.equal(true)
        expect(args.verifyMerkle).to.equal(true)
    })

    it('disables verification defaults off mainnet', function () {
        const args = defaultArgs()
        args.network = 'bitcoin-testnet'

        expect(resolveVerifyDefaults(args)).to.equal(args)
        expect(args.verifyChain).to.equal(false)
        expect(args.verifyMerkle).to.equal(false)
    })

    it('preserves explicit verification choices and the merkle invariant', function () {
        const disabled = resolveVerifyDefaults({
            network: 'bitcoin-mainnet',
            verifyChain: false,
            verifyMerkle: false,
        })
        const merkle = resolveVerifyDefaults({
            network: 'bitcoin-testnet',
            verifyChain: false,
            verifyMerkle: true,
        })

        expect(disabled.verifyChain).to.equal(false)
        expect(disabled.verifyMerkle).to.equal(false)
        expect(merkle.verifyChain).to.equal(true)
        expect(merkle.verifyMerkle).to.equal(true)
    })
}

function testTipSafety() {
    it('clamps implicit endpoints to each network undo window', function () {
        expect(effectiveTipSafety(10, null, 'bitcoin-mainnet')).to.equal(12)
        expect(effectiveTipSafety(10, null, 'bitcoin-testnet')).to.equal(120)
    })

    it('keeps larger margins and bypasses the clamp for explicit endpoints', function () {
        expect(effectiveTipSafety(20, null, 'bitcoin-mainnet')).to.equal(20)
        expect(effectiveTipSafety(10, 500000, 'bitcoin-mainnet')).to.equal(10)
        expect(effectiveTipSafety(10, 500000, 'bitcoin-testnet')).to.equal(10)
    })
}

describe('bulk-sync orchestrator CLI options @unit', function () {
    testDefaultArgs()
    testNetworkDetection()
    testVerificationDefaults()
    testTipSafety()
})
