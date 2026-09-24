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
//
// XChainUtxoTracker, BlockchainConnector and LevelUpStore each split their
// methods into part modules that get put back on the class prototype by a
// local installMethods function. Object.assign would install them as
// ENUMERABLE own properties, unlike a method written directly in the class
// body, which would change what for...in over an instance, Object.keys of
// the prototype and a spread of it return. This pins every method the part
// modules contribute to non-enumerable, writable, configurable and callable,
// and exercises the installer's generic contract through the copy
// XChainUtxoTracker.js exports for this purpose (blockchain_connector.js
// and level_up_db.js carry byte-identical private copies, checked
// indirectly through their own prototype's descriptor rows below).

const assert = require('assert');
const { installMethods } = require('../../src/XChainUtxoTracker.js');

// Every key a source module contributes: its own enumerable keys, matching
// what Object.assign would have copied.
function sourceKeys(source) {
    return Reflect.ownKeys(source).filter((key) => Object.prototype.propertyIsEnumerable.call(source, key));
}

// Asserts every key the given sources contribute lands on proto as a
// non-enumerable, writable, configurable, callable data property, exactly
// as a class-body method would. Returns the set of keys checked.
function assertInstalledLikeClassMethods(proto, sources, label) {
    const installedKeys = new Set();
    for (const source of sources) {
        for (const key of sourceKeys(source)) {
            installedKeys.add(key);
            assert.ok(Object.prototype.hasOwnProperty.call(proto, key),
                `${label}: ${String(key)} missing from prototype`);
            const descriptor = Object.getOwnPropertyDescriptor(proto, key);
            assert.deepStrictEqual(
                { enumerable: descriptor.enumerable, writable: descriptor.writable, configurable: descriptor.configurable },
                { enumerable: false, writable: true, configurable: true },
                `${label}: ${String(key)} descriptor flags`
            );
            assert.strictEqual(typeof proto[key], 'function', `${label}: ${String(key)} is not callable`);
            assert.strictEqual(proto[key], source[key], `${label}: ${String(key)} value mismatch`);
        }
    }
    assert.ok(installedKeys.size > 1, `${label}: expected more than one installed method`);
    assert.deepStrictEqual(
        Object.keys(proto).filter((key) => installedKeys.has(key)),
        [],
        `${label}: installed methods leaked into the enumerable own keys`
    );
    return installedKeys;
}

describe('prototype method descriptors of split classes', function () {

    describe('XChainUtxoTracker', function () {
        const XChainUtxoTracker = require('../../src/XChainUtxoTracker.js');
        const sources = [
            require('../../src/XChainUtxoTracker/halt_marker.js'),
            require('../../src/XChainUtxoTracker/last_blocks_window.js'),
            require('../../src/XChainUtxoTracker/fetch_failures_and_halt.js'),
            require('../../src/XChainUtxoTracker/status_and_stop.js'),
            require('../../src/XChainUtxoTracker/address_queries.js'),
            require('../../src/XChainUtxoTracker/transaction_parsing.js'),
            require('../../src/XChainUtxoTracker/reorg_verification.js'),
            require('../../src/XChainUtxoTracker/sync_loop.js'),
            require('../../src/XChainUtxoTracker/mempool_refresh.js'),
        ];

        it('installs every part-module method non-enumerable and callable', function () {
            assertInstalledLikeClassMethods(XChainUtxoTracker.prototype, sources, 'XChainUtxoTracker');
        });

        it('keeps for...in over an instance\'s prototype chain free of installed keys', function () {
            assert.deepStrictEqual(Object.keys(XChainUtxoTracker.prototype), []);
        });
    });

    describe('BlockchainConnector', function () {
        const BlockchainConnector = require('../../src/chain/blockchain_connector.js');
        const sources = [
            require('../../src/chain/blockchain_connector/transport_and_mempool.js'),
            require('../../src/chain/blockchain_connector/block_queries.js'),
            require('../../src/chain/blockchain_connector/batch_fetch.js'),
        ];

        it('installs every part-module method non-enumerable and callable', function () {
            assertInstalledLikeClassMethods(BlockchainConnector.prototype, sources, 'BlockchainConnector');
        });

        it('keeps for...in over an instance\'s prototype chain free of installed keys', function () {
            assert.deepStrictEqual(Object.keys(BlockchainConnector.prototype), []);
        });
    });

    describe('LevelUpStore', function () {
        const LevelUpStore = require('../../src/store/level_up_db.js');
        const sources = [
            require('../../src/store/level_up_db/store_lifecycle.js'),
            require('../../src/store/level_up_db/blocks_and_transactions.js'),
            require('../../src/store/level_up_db/inputs.js'),
            require('../../src/store/level_up_db/outputs.js'),
            require('../../src/store/level_up_db/output_cleanup.js'),
            require('../../src/store/level_up_db/output_scripts.js'),
        ];

        it('installs every part-module method non-enumerable and callable', function () {
            assertInstalledLikeClassMethods(LevelUpStore.prototype, sources, 'LevelUpStore');
        });

        it('keeps for...in over an instance\'s prototype chain free of installed keys', function () {
            assert.deepStrictEqual(Object.keys(LevelUpStore.prototype), []);
        });
    });

    describe('installMethods', function () {
        it('defines methods with the flags a class body gives them', function () {
            const target = {};
            function m(a, b) { return a + b; }
            installMethods(target, { m });
            assert.deepStrictEqual(Object.getOwnPropertyDescriptor(target, 'm'),
                { value: m, writable: true, enumerable: false, configurable: true });
        });

        it('installs sources in order, a later source winning a shared key', function () {
            const first = () => 1, second = () => 2, other = () => 3;
            const target = installMethods({}, { a: first, b: other }, { a: second });
            assert.strictEqual(target.a, second);
            assert.strictEqual(target.b, other);
        });

        it('copies symbol keys and skips a source key that is not enumerable', function () {
            const sym = Symbol('s');
            const source = { [sym]: () => 's' };
            Object.defineProperty(source, 'hidden', { value: () => 'h', enumerable: false });
            const target = installMethods({}, source);
            assert.strictEqual(typeof target[sym], 'function');
            assert.strictEqual(Object.prototype.hasOwnProperty.call(target, 'hidden'), false);
        });

        it('returns the target', function () {
            const target = {};
            assert.strictEqual(installMethods(target, {}), target);
        });
    });
});
