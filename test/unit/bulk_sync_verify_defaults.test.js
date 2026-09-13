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

// Bulk-sync verification defaults ON for mainnet bootstraps.
// A mainnet bootstrap seeds the production UTXO set, so a silently corrupt
// dump is a consensus-facing hazard. Decision (2026-07-17): --verify-chain and
// --verify-merkle default ON for *-mainnet networks, with explicit
// --no-verify-chain / --no-verify-merkle opt-out flags. Non-mainnet networks
// (regtest/testnet) keep verification OFF by default.

const { expect } = require('chai');
const { parseArgs, resolveVerifyDefaults, isMainnetNetwork } = require('../../src/bulk-sync/orchestrator');

function argsFor(network, ...extra) {
    return parseArgs(['node', 'orchestrator.js',
        '--network', network, '--out', '/tmp/x', '--db', '/tmp/y', ...extra]);
}

describe('bulk-sync verify defaults @unit', function () {

    it('detects mainnet networks by the -mainnet suffix', function () {
        expect(isMainnetNetwork('bitcoin-mainnet')).to.equal(true);
        expect(isMainnetNetwork('dogecoin-mainnet')).to.equal(true);
        expect(isMainnetNetwork('bitcoin-regtest')).to.equal(false);
        expect(isMainnetNetwork('litecoin-testnet')).to.equal(false);
        expect(isMainnetNetwork('mainnet-bitcoin')).to.equal(false);
    });

    it('defaults both verifications ON for a mainnet bootstrap', function () {
        const a = argsFor('bitcoin-mainnet');
        expect(a.verifyChain).to.equal(true);
        expect(a.verifyMerkle).to.equal(true);
    });

    it('defaults both verifications OFF for regtest and testnet', function () {
        for (const net of ['bitcoin-regtest', 'dogecoin-testnet']) {
            const a = argsFor(net);
            expect(a.verifyChain).to.equal(false);
            expect(a.verifyMerkle).to.equal(false);
        }
    });

    it('mainnet opt-out via --no-verify-merkle --no-verify-chain disables both', function () {
        const a = argsFor('bitcoin-mainnet', '--no-verify-merkle', '--no-verify-chain');
        expect(a.verifyChain).to.equal(false);
        expect(a.verifyMerkle).to.equal(false);
    });

    it('--no-verify-merkle alone on mainnet keeps chain verification on', function () {
        const a = argsFor('litecoin-mainnet', '--no-verify-merkle');
        expect(a.verifyChain).to.equal(true);
        expect(a.verifyMerkle).to.equal(false);
    });

    it('merkle implies chain: --no-verify-chain alone on mainnet is overridden by default merkle', function () {
        const a = argsFor('bitcoin-mainnet', '--no-verify-chain');
        expect(a.verifyMerkle).to.equal(true);
        expect(a.verifyChain).to.equal(true);
    });

    it('explicit --verify-merkle on regtest turns chain verification on too', function () {
        const a = argsFor('bitcoin-regtest', '--verify-merkle');
        expect(a.verifyChain).to.equal(true);
        expect(a.verifyMerkle).to.equal(true);
    });

    it('explicit --verify-chain on regtest leaves merkle off', function () {
        const a = argsFor('bitcoin-regtest', '--verify-chain');
        expect(a.verifyChain).to.equal(true);
        expect(a.verifyMerkle).to.equal(false);
    });

    it('resolveVerifyDefaults only fills nulls, never clobbers explicit values', function () {
        const kept = resolveVerifyDefaults({ network: 'bitcoin-mainnet', verifyChain: false, verifyMerkle: false });
        expect(kept.verifyChain).to.equal(false);
        expect(kept.verifyMerkle).to.equal(false);
        const filled = resolveVerifyDefaults({ network: 'bitcoin-mainnet', verifyChain: null, verifyMerkle: null });
        expect(filled.verifyChain).to.equal(true);
        expect(filled.verifyMerkle).to.equal(true);
    });
});
