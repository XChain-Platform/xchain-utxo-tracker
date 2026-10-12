/*********************************************************************
 *
 * Copyright © 2025-2026 Dankest, LLC
 * Based on XChain Platform by Dankest, LLC - https://dankest.llc
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 *
 * This file is part of XChain Platform. Licensed under the GNU Affero
 * General Public License v3.0 or later; see LICENSE.md.
 *
 *********************************************************************/

'use strict';

const { expect } = require('chai');
const { build, compare, vendoredFiles } = require('../../../bin/pin-identity.js');

describe('identity pin tool', function () {
    it('builds a pin that compares equal to itself', function () {
        const pin = build();

        expect(compare(pin, pin)).to.deep.equal([]);
    });

    it('reports exactly the file whose digest changed', function () {
        const pin = build();
        const rel = Object.keys(pin.files)[0];
        expect(rel).to.be.a('string').and.not.equal('');
        const digest = pin.files[rel] === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
        const changed = {
            ...pin,
            files: { ...pin.files, [rel]: digest },
        };

        expect(compare(pin, changed)).to.deep.equal([`CHANGED ${rel}`]);
    });

    it('keeps vendored file and serialized pin key order deterministic', function () {
        const files = vendoredFiles();
        const first = build();
        const second = build();

        expect(files).to.deep.equal([...files].sort());
        expect(Object.keys(first.files)).to.deep.equal(files);
        expect(JSON.stringify(second)).to.equal(JSON.stringify(first));
    });
});
