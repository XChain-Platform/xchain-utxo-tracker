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
 ********************************************************************/

'use strict';

const { expect } = require('chai');
const { evaluateRestoreAgainstNodeTip } = require('../../../src/bootstrap/node_tip_guard.js');

describe('bootstrap restore node-tip verdict', function () {
    it('refuses only when a non-IBD node is below the archive', function () {
        expect(evaluateRestoreAgainstNodeTip({
            archiveHeight: 100,
            chainInfo: { blocks: 95, initialblockdownload: false },
        })).to.include({ verdict: 'behind-refuse', archiveHeight: 100, nodeHeight: 95, gap: 5, ibd: false });
        expect(evaluateRestoreAgainstNodeTip({
            archiveHeight: 100,
            chainInfo: { blocks: 95, initialblockdownload: true },
        })).to.include({ verdict: 'behind-wait', gap: 5, ibd: true });
    });

    it('accepts a node at or above the archive height', function () {
        for (const blocks of [100, 120]) {
            expect(evaluateRestoreAgainstNodeTip({ archiveHeight: 100, chainInfo: { blocks } }))
                .to.include({ verdict: 'ok', nodeHeight: blocks, gap: 0 });
        }
    });

    it('returns unknown for an unusable archive height or node response', function () {
        for (const archiveHeight of [null, -1, 1.5, '100']) {
            expect(evaluateRestoreAgainstNodeTip({ archiveHeight, chainInfo: { blocks: 95 } }).verdict)
                .to.equal('unknown');
        }
        for (const chainInfo of [null, {}, { blocks: '95' }, { blocks: -1 }]) {
            expect(evaluateRestoreAgainstNodeTip({ archiveHeight: 100, chainInfo }).verdict)
                .to.equal('unknown');
        }
    });
});
