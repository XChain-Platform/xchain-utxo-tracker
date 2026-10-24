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

// Additional unit tests for LevelUpDb.js covering uncovered lines not reached
// by LevelUpDb.test.js. All stores use in-memory MemoryLevel (no disk).

const { expect } = require('chai');
const crypto = require('crypto');
const LevelUpStore = require('../../../src/store/level_up_db');

function randHash() { return crypto.randomBytes(32).toString('hex'); }
function randHash8() { return crypto.randomBytes(8).toString('hex'); }
function randBuf32() { return crypto.randomBytes(32); }

let dbCounter = 0;
function makeDb() {
    return new LevelUpStore('more-test-' + Date.now() + '-' + (++dbCounter), true);
}

describe('LevelUpDb (extended coverage)', function () {

    describe('pagination cursor edge cases', function () {
        let db;
        beforeEach(async function () { db = makeDb(); await db.createDatabase(); });
        afterEach(async function () { try { await db.close(); } catch (e) {} });

        // Every case but the width ones carries a 64-hex txid, so each is
        // rejected for the reason its label names and not for its width.
        const TXID = 'deadbeef'.repeat(8);
        const cursorCases = [
            ['non-string (number)', 42],
            ['no colon', TXID],
            ['colon at position 0', ':0'],
            ['txidHex too short (14 hex)', 'deadbeefdeadbe:0'],
            ['txidHex not hex', 'g'.repeat(64) + ':0'],
            ['vout not digits', TXID + ':abc'],
            ['vout > 0xFFFFFFFF', TXID + ':4294967296'],
            ['a well-formed 16-hex txid (the layout 1 cursor form)', 'deadbeefdeadbeef:0'],
        ];

        for (const [label, cursor] of cursorCases) {
            it(`throws INVALID_CURSOR for ${label}`, async function () {
                const scriptHash = randHash();
                let err = null;
                try {
                    await db.getOutputsScriptPubKey(scriptHash, { after: cursor });
                } catch (e) {
                    err = e;
                }
                expect(err, `expected INVALID_CURSOR for cursor ${JSON.stringify(cursor)}`).to.be.an('error');
                expect(err.code).to.equal('INVALID_CURSOR');
            });
        }

        it('accepts a well-formed 64-hex txid cursor and resumes after it', async function () {
            const scriptHash = randHash();
            const txids = [randHash(), randHash(), randHash()].sort();
            for (const txid of txids) {
                await db.insertOutput({ scriptPubKey: scriptHash, txHash: txid, outputIndex: 0, value: 1n, height: 1, fullTxHash: txid });
            }
            await db.endTransaction(true);
            const page = await db.getOutputsScriptPubKey(scriptHash, { after: txids[0] + ':0' });
            expect(page.map((o) => o.txid)).to.deep.equal(txids.slice(1));
        });
    });

});
