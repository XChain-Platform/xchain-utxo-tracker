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

// Boot-time consensus-pin verification, mirroring the decoder, indexer and hub.
// The tracker constructor must call coins.verifyConsensusPin(<net>) fail-closed
// BEFORE it reads the WIRE_FORMAT auxPow decision or opens any DB, so a drifted
// or partially re-vendored coin bundle halts instead of fetching and stripping
// block bytes under divergent network params once a pin is armed. The mainnet
// pin is null today, so the live mainnet check is a no-op.
//
// The standalone bulk seeder (src/bulk-sync/dump.js) is its own process and is
// covered here too: it never constructs a tracker, so the constructor check
// cannot reach it.

const { expect } = require('chai');
const sinon = require('sinon');
const fs = require('fs');
const path = require('path');

const XChainUtxoTracker = require('../../src/XChainUtxoTracker');
const coins = require('../../src/coins');

function makeTracker(networkKey) {
    return new XChainUtxoTracker(networkKey, '127.0.0.1', '8332', 'u', 'p', 'db-consensus-pin-boot', false);
}

describe('utxo-tracker boot consensus-pin verification', function () {
    afterEach(() => sinon.restore());

    it('derives the consensus network from the "<fullname>-<network>" key', function () {
        expect(makeTracker('dogecoin-mainnet').consensusNetwork).to.equal('mainnet');
        expect(makeTracker('bitcoin-regtest').consensusNetwork).to.equal('regtest');
        expect(makeTracker('litecoin-testnet').consensusNetwork).to.equal('testnet');
    });

    it('verifyConsensusPin skips on the (currently null) mainnet pin', function () {
        expect(coins.verifyConsensusPin('mainnet')).to.deep.equal({ ok: true, skipped: true });
    });

    it('passes on the vendored bundle for every armed network', function () {
        for (const net of coins.NETWORKS) coins.verifyConsensusPin(net);
    });

    it('halts fail-closed on a pin mismatch, before any node connector or DB handle', function () {
        const stub = sinon.stub(coins, 'verifyConsensusPin')
            .throws(new Error('CONSENSUS CONFIG PIN MISMATCH (test)'));
        expect(() => makeTracker('dogecoin-regtest')).to.throw(/CONSENSUS CONFIG PIN MISMATCH/);
        expect(stub.calledOnceWithExactly('regtest')).to.equal(true);
    });

    it('runs the pin check before the WIRE_FORMAT auxPow decision', function () {
        // Ordering matters: auxPow gates how every DOGE block's bytes are fetched
        // and stripped, so the pin must be proved before that field is read.
        const src = fs.readFileSync(
            path.join(__dirname, '..', '..', 'src', 'XChainUtxoTracker.js'), 'utf8');
        const pinAt = src.indexOf("verifyConsensusPin(this.consensusNetwork)");
        const auxAt = src.indexOf('this.auxPow = WIRE_FORMAT[');
        expect(pinAt).to.be.greaterThan(-1);
        expect(auxAt).to.be.greaterThan(-1);
        expect(pinAt).to.be.lessThan(auxAt);
    });

    it('the standalone bulk seeder verifies the pin too', function () {
        // Scoped to main(), because dump.js declares the WIRE_FORMAT-reading
        // helpers above main() and textual order across the whole file is not
        // execution order.
        const src = fs.readFileSync(
            path.join(__dirname, '..', '..', 'src', 'bulk-sync', 'dump.js'), 'utf8');
        const main = src.slice(src.indexOf('async function main()'));
        expect(main).to.not.equal('');
        const pinAt = main.indexOf('coins.verifyConsensusPin(args.netName)');
        const connectorAt = main.indexOf('new BlockchainConnector(');
        expect(pinAt).to.be.greaterThan(-1);
        expect(connectorAt).to.be.greaterThan(-1);
        expect(pinAt).to.be.lessThan(connectorAt);
    });
});
