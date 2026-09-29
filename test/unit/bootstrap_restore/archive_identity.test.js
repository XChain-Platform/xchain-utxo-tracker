/*********************************************************************
 *
 * Copyright © 2025–2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC – https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md. A commercial
 * license (without AGPL source-disclosure terms) is available -
 * contact legal@dankest.llc.
 *
 *********************************************************************/

'use strict';

const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createHash, generateKeyPairSync, sign: signAsymmetric } = require('crypto');

const { validateBootstrapArchiveOrThrow } = require('../../../src/api.js');
const { trackerArchiveIdentity, compareArchiveIdentity, parseArchiveMeta } = require('../../../src/bootstrap/restore_validation.js');

// One key signs every coin/network, so a real signed archive for another combo
// verifies; the wrapper's bootstrap.json is what says which tracker it is for.
const TARGET = { module: 'xchain-utxo-tracker', coin: 'bitcoin', network: 'mainnet' };
const meta = (fields) => ({ format: 1, module: 'xchain-utxo-tracker', coin: 'bitcoin', network: 'mainnet',
    height: 100, created: '2026-09-29T00:00:00Z', ...fields });

const sha256File = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// A publisher-shaped wrapper: bootstrap.json first (when given), then an inner
// data.tar.gz holding a root-level LevelDB store and its data.sha256.
function buildWrapper(dir, metaBody) {
    const store = path.join(dir, 'store');
    const stage = path.join(dir, 'stage');
    fs.mkdirSync(store, { recursive: true });
    fs.mkdirSync(stage, { recursive: true });
    fs.writeFileSync(path.join(store, 'CURRENT'), 'MANIFEST-000001\n');
    fs.writeFileSync(path.join(store, 'MANIFEST-000001'), 'x'.repeat(64));
    const inner = path.join(stage, 'data.tar.gz');
    if (spawnSync('tar', ['-czf', inner, '-C', store, '.']).status !== 0) throw new Error('inner tar failed');
    fs.writeFileSync(path.join(stage, 'data.sha256'), `${sha256File(inner)}  data.tar.gz\n`);
    const members = ['data.tar.gz', 'data.sha256'];
    if (metaBody !== null) {
        fs.writeFileSync(path.join(stage, 'bootstrap.json'), typeof metaBody === 'string' ? metaBody : JSON.stringify(metaBody));
        members.unshift('bootstrap.json');
    }
    const archive = path.join(dir, 'wrapper.tar.gz');
    if (spawnSync('tar', ['-czf', archive, '-C', stage, ...members]).status !== 0) throw new Error('wrapper tar failed');
    return archive;
}

// Pin a throwaway ed25519 key and sign the archive as the publisher does.
function signWithPinnedKey(dir, archive) {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pubPath = path.join(dir, 'test_pubkey.pem');
    fs.writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }));
    process.env.UTXO_TRACKER_BOOTSTRAP_PUBKEY = pubPath;
    const sig = signAsymmetric(null, Buffer.from(sha256File(archive), 'hex'), privateKey);
    fs.writeFileSync(archive + '.sig', `v1 ed25519 ${sig.toString('base64')}\n`);
}

const unwrapDirs = () => fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('xchain-restore-unwrap-')).length;

// Assert a pre-wipe refusal naming the field, with no unwrap temp dir left behind.
async function expectRefusal(archive, pattern, identity = TARGET) {
    const before = unwrapDirs();
    let err = null;
    try { await validateBootstrapArchiveOrThrow(archive, { identity }); } catch (e) { err = e; }
    expect(err, 'expected a pre-wipe identity refusal').to.be.an('error');
    expect(err.message).to.match(/bootstrap\.json declares/);
    expect(err.message).to.match(pattern);
    expect(unwrapDirs(), 'the refused unwrap must clean its temp dir').to.equal(before);
}

async function expectAccepted(archive) {
    const res = await validateBootstrapArchiveOrThrow(archive, { identity: TARGET });
    expect(res.effectiveSource).to.match(/data\.tar\.gz$/);
    fs.rmSync(res.tmpDir, { recursive: true, force: true });
}

describe('validateBootstrapArchiveOrThrow archive identity gate', function () {
    let tmp;
    beforeEach(function () {
        tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xchain-identity-test-'));
        // Unsigned fixtures take the local-snapshot opt-out; the signed case clears it.
        process.env.BOOTSTRAP_RESTORE_ALLOW_UNSIGNED = '1';
    });
    afterEach(function () {
        delete process.env.BOOTSTRAP_RESTORE_ALLOW_UNSIGNED;
        delete process.env.UTXO_TRACKER_BOOTSTRAP_PUBKEY;
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    it('refuses a correctly signed wrapper published for another coin and network', async function () {
        delete process.env.BOOTSTRAP_RESTORE_ALLOW_UNSIGNED;
        const archive = buildWrapper(tmp, meta({ coin: 'litecoin', network: 'testnet' }));
        signWithPinnedKey(tmp, archive);
        await expectRefusal(archive, /coin "litecoin", network "testnet"/);
    });

    for (const [field, value] of [['module', 'xchain-decoder'], ['coin', 'dogecoin'], ['network', 'regtest']]) {
        it(`refuses a wrapper whose ${field} alone differs`, async function () {
            await expectRefusal(buildWrapper(tmp, meta({ [field]: value })), new RegExp(`${field} "${value}"`));
        });
    }

    it('accepts a matching identity, compared case-insensitively', async function () {
        await expectAccepted(buildWrapper(tmp, meta({ coin: 'Bitcoin', network: 'MAINNET' })));
    });

    it('accepts a legacy wrapper with no bootstrap.json, an unparseable one, and null coin/network', async function () {
        for (const body of [null, 'not json', meta({ coin: null, network: null })]) {
            await expectAccepted(buildWrapper(fs.mkdtempSync(path.join(tmp, 'case-')), body));
        }
    });

    it('still refuses a foreign module when the tracker NETWORK names no coin/network', async function () {
        const noNet = { module: 'xchain-utxo-tracker', coin: null, network: null };
        await expectRefusal(buildWrapper(tmp, meta({ module: 'xchain-indexer' })), /module "xchain-indexer"/, noNet);
    });
});

describe('restore archive identity helpers', function () {
    it('splits the combined NETWORK xchain-node sets at its last dash', function () {
        expect(trackerArchiveIdentity('bitcoin-mainnet')).to.deep.equal(TARGET);
        expect(trackerArchiveIdentity('Bitcoin-Cash-Testnet'))
            .to.deep.equal({ module: 'xchain-utxo-tracker', coin: 'bitcoin-cash', network: 'testnet' });
    });

    it('leaves coin/network null for a NETWORK that does not split', function () {
        for (const v of [undefined, '', 'regtest', '-mainnet', 'bitcoin-'])
            expect(trackerArchiveIdentity(v), String(v)).to.deep.equal({ module: 'xchain-utxo-tracker', coin: null, network: null });
    });

    it('reads only format-1 metadata', function () {
        expect(parseArchiveMeta(JSON.stringify({ format: 2, module: 'x' }))).to.equal(null);
        expect(parseArchiveMeta('{')).to.equal(null);
        expect(parseArchiveMeta(JSON.stringify({ format: 1, module: 'xchain-utxo-tracker', coin: 'bitcoin', network: 7 })))
            .to.deep.equal({ module: 'xchain-utxo-tracker', coin: 'bitcoin', network: null });
    });

    it('marks a field unchecked, never mismatched, when either side lacks it', function () {
        expect(compareArchiveIdentity(null, TARGET))
            .to.deep.equal({ status: 'unchecked', mismatches: [], unchecked: ['module', 'coin', 'network'] });
        expect(compareArchiveIdentity(TARGET, { ...TARGET, coin: null }).status).to.equal('unchecked');
        expect(compareArchiveIdentity(TARGET, TARGET).status).to.equal('match');
        expect(compareArchiveIdentity({ ...TARGET, network: 'testnet' }, TARGET).mismatches)
            .to.deep.equal([{ field: 'network', archive: 'testnet', target: 'mainnet' }]);
    });
});
